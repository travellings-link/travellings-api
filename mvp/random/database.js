const { Sequelize, DataTypes, QueryTypes } = require('sequelize');
const { createCandidateSource } = require('../../modules/random/source');
const { PREFETCH_LIMIT } = require('../../modules/random/prefetch');
const { createGuardedMysql, destroyMysqlConnection } = require('./mysqlClient');

function createReadOnlyDatabase(config, createSequelize = (...args) => new Sequelize(...args)) {
    const guardedMysql = createGuardedMysql({ queryTimeoutMs: config.clientQueryTimeoutMs ?? 3000 });
    const sql = createSequelize(config.name, config.user, config.password, {
        host: config.host,
        port: config.port,
        dialect: 'mysql',
        dialectModule: guardedMysql.dialectModule,
        logging: false,
        retry: { max: 0 },
        pool: { max: config.poolMax, min: 0, acquire: 5000, idle: 10000 },
        dialectOptions: { connectTimeout: 5000, multipleStatements: false },
        hooks: {
            afterConnect: connection => new Promise((resolve, reject) => {
                connection.query(
                    'SET SESSION transaction_read_only = 1, max_execution_time = ?',
                    [config.queryTimeoutMs],
                    error => {
                        if (error) {
                            // Do not leave an unconfigured connection open after hook failure.
                            destroyMysqlConnection(connection);
                            reject(error);
                        } else resolve();
                    },
                );
            }),
            afterQuery: async (options, query) => {
                if (guardedMysql.didTimeout(query.connection)) {
                    // Retire the poisoned resource before Sequelize's finally
                    // releases it. A subsequent acquire gets a new TCP session.
                    await sql.connectionManager.destroyConnection(query.connection);
                }
            },
        },
    });

    // Define a read model only. Never import sqlModel/sqlConfig, sync, or migrate.
    const webModel = sql.define('webs', {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        status: DataTypes.STRING,
        name: DataTypes.STRING,
        link: DataTypes.STRING,
        tag: DataTypes.STRING,
    }, { tableName: 'webs', timestamps: false });

    return Object.freeze({
        kind: 'mysql',
        findCandidates: createCandidateSource(webModel),
        prefetchCandidates: createCandidateSource(webModel, { limit: PREFETCH_LIMIT }),
        resampleCandidates: createCandidateSource(webModel, { limit: PREFETCH_LIMIT }),
        check: async () => {
            // Check table/column visibility and SELECT privilege without reading site rows.
            await sql.query('SELECT id, status, name, link, tag FROM webs LIMIT 0', { type: QueryTypes.SELECT });
        },
        close: () => sql.close(),
    });
}

module.exports = { createReadOnlyDatabase };

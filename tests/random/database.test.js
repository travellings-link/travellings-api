const test = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize, QueryTypes } = require('sequelize');
const { createReadOnlyDatabase } = require('../../mvp/random/database');
const { readConfig } = require('../../mvp/random/config');

const env = { RANDOM_MVP_DB_NAME: 'test_database', RANDOM_MVP_DB_USER: 'readonly_test' };

test('configuration is isolated from production credentials and validates all resource bounds', () => {
    assert.throws(() => readConfig({ DB_USER: 'root', DB_NAME: 'production' }), /RANDOM_MVP_DB_NAME/);
    const config = readConfig(env);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 14515);
    assert.equal(config.database.poolMax, 4);
    assert.equal(config.database.clientQueryTimeoutMs, 3000);
    assert.equal(readConfig({ ...env, RANDOM_MVP_QUERY_TIMEOUT_MS: '4000' }).database.clientQueryTimeoutMs, 5000);
    assert.equal(config.maxInFlight, 8);
    assert.equal(config.redis.database, 5);
    assert.equal(config.cacheTtlSeconds, 30);
    for (const [key, value] of Object.entries({ RANDOM_MVP_PORT: '0', RANDOM_MVP_DB_POOL_MAX: '100',
        RANDOM_MVP_QUERY_TIMEOUT_MS: '0', RANDOM_MVP_MAX_IN_FLIGHT: '0', RANDOM_MVP_COOKIE_SECURE: 'sometimes',
        RANDOM_MVP_REDIS_DB: '0', RANDOM_MVP_REDIS_PORT: '0', RANDOM_MVP_CACHE_TTL_SECONDS: '0',
        RANDOM_MVP_QUERY_CLIENT_TIMEOUT_MS: '0' })) {
        assert.throws(() => readConfig({ ...env, [key]: value }));
    }
});

test('the real Sequelize generator emits one bounded SELECT with the mainline filters', async t => {
    let sequelize, options;
    const queries = [];
    const database = createReadOnlyDatabase(readConfig(env).database, (...args) => {
        options = args[3];
        sequelize = new Sequelize(...args);
        sequelize.query = async (sql, queryOptions) => { queries.push({ sql, options: queryOptions }); return []; };
        return sequelize;
    });
    t.after(() => database.close());
    assert.deepEqual(Object.keys(database).sort(), ['check', 'close', 'findCandidates', 'kind', 'prefetchCandidates']);
    await database.findCandidates({ tag: 'blog' });
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /^SELECT `id`, `name`, `link`, `tag` FROM `webs`/);
    assert.match(queries[0].sql, /`status` = 'RUN'/);
    assert.match(queries[0].sql, /`tag` LIKE '%blog%'/);
    assert.match(queries[0].sql, /ORDER BY RAND\(\) LIMIT 8;/);
    assert.equal(queries[0].options.type, QueryTypes.SELECT);
    assert.doesNotMatch(queries[0].sql, /COUNT\(|OFFSET|INSERT|UPDATE|DELETE|CREATE|ALTER/);
    await database.findCandidates();
    assert.equal(queries.length, 2);
    assert.doesNotMatch(queries[1].sql, /LIKE/);
    await database.prefetchCandidates({ tag: 'blog' });
    assert.equal(queries.length, 3);
    assert.match(queries[2].sql, /ORDER BY RAND\(\) LIMIT 64;/);
    await database.check();
    assert.equal(queries.length, 4);
    assert.equal(queries[3].sql, 'SELECT id, status, name, link, tag FROM webs LIMIT 0');
    assert.equal(options.retry.max, 0);
    assert.equal(options.dialectOptions.multipleStatements, false);
    assert.equal(options.pool.max, 4);
});

test('each new connection must finish read-only and timeout initialization before being usable', async t => {
    let options;
    const database = createReadOnlyDatabase(readConfig(env).database, (...args) => {
        options = args[3]; return new Sequelize(...args);
    });
    t.after(() => database.close());
    let finish;
    let initialized = false;
    let destroyed = false;
    const promise = options.hooks.afterConnect({
        query(sql, values, callback) {
            assert.equal(sql, 'SET SESSION transaction_read_only = 1, max_execution_time = ?');
            assert.deepEqual(values, [2000]);
            finish = callback;
        },
        destroy() { destroyed = true; },
    }).then(() => { initialized = true; });
    await Promise.resolve();
    assert.equal(initialized, false);
    finish(null);
    await promise;
    assert.equal(initialized, true);
    assert.equal(destroyed, false);
    await assert.rejects(options.hooks.afterConnect({
        query(sql, values, callback) { callback(Error('cannot set read-only')); },
        destroy() { destroyed = true; },
    }), /cannot set read-only/);
    assert.equal(destroyed, true);
});

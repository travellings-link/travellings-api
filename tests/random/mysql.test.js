const test = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize, QueryTypes } = require('sequelize');
const { loadConfig } = require('../../mvp/random/config');
const { createReadOnlyDatabase } = require('../../mvp/random/database');

test('real MySQL: read-only session, timeout, table access, and bounded sampling', {
    skip: process.env.RANDOM_MVP_MYSQL_TEST !== '1',
}, async t => {
    const config = loadConfig();
    let sql;
    const database = createReadOnlyDatabase(config.database, (...args) => {
        sql = new Sequelize(...args); return sql;
    });
    t.after(() => database.close());
    await database.check();
    const [session] = await sql.query('SELECT @@session.transaction_read_only AS read_only, @@session.max_execution_time AS timeout_ms', { type: QueryTypes.SELECT });
    assert.equal(Number(session.read_only), 1);
    assert.equal(Number(session.timeout_ms), config.database.queryTimeoutMs);
    const candidates = await database.findCandidates();
    assert.ok(candidates.length <= 8);
    assert.equal(new Set(candidates.map(candidate => candidate.id)).size, candidates.length);
    for (const candidate of candidates) assert.deepEqual(Object.keys(candidate).sort(), ['id', 'link', 'name', 'tag']);
});

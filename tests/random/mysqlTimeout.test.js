const test = require('node:test');
const assert = require('node:assert/strict');
const { once, EventEmitter } = require('node:events');
const http = require('node:http');
const net = require('node:net');
const { Sequelize } = require('sequelize');
const { createReadOnlyDatabase } = require('../../mvp/random/database');
const { createGuardedMysql } = require('../../mvp/random/mysqlClient');
const { createPrefetchSource, cacheKey } = require('../../modules/random/prefetch');
const { emptyHistory, appendHistory, loadHistory, serializeHistory } = require('../../modules/random/history');
const { RandomMetrics } = require('../../modules/random/metrics');
const { createMvpApp } = require('../../mvp/random/app');
const { MemoryCache } = require('./memoryCache');
const { startMysqlFaultServer } = require('./mysqlFaultServer');

const logger = { info() {}, error() {} };
const isClientTimeout = error => (error.original || error).code === 'RANDOM_MYSQL_CLIENT_TIMEOUT';

function openDatabase(t, fault) {
    const clients = [];
    let sql;
    const database = createReadOnlyDatabase({
        host: '127.0.0.1', port: fault.port, name: 'fault_test', user: 'readonly', password: '',
        poolMax: 1, queryTimeoutMs: 100, clientQueryTimeoutMs: 200,
    }, (...args) => {
        const guardedCreate = args[3].dialectModule.createConnection;
        args[3].dialectModule.createConnection = config => {
            const client = guardedCreate(config); clients.push(client); return client;
        };
        sql = new Sequelize(...args);
        return sql;
    });
    t.after(() => database.close());
    return { database, clients, sql };
}

function get(server, path = '/random', headers = {}) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path, headers, agent: false }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body, json: () => JSON.parse(body) }));
        }).on('error', reject);
    });
}

test('silent TCP query is destroyed, evicted from the pool, and replaced on recovery', { timeout: 5000 }, async t => {
    const fault = await startMysqlFaultServer(t);
    const { database, clients, sql } = openDatabase(t, fault);
    await database.check();
    const oldClient = clients.at(-1);
    fault.stallCandidates = true;
    await assert.rejects(database.prefetchCandidates(), isClientTimeout);
    assert.equal(oldClient.stream.destroyed, true);
    assert.equal(sql.connectionManager.pool.using, 0);
    assert.equal(sql.connectionManager.pool.size, 0);
    assert.equal(fault.candidateConnections.length, 1);
    fault.stallCandidates = false;
    const rows = await database.prefetchCandidates();
    assert.equal(rows[0].id, 1);
    assert.notEqual(clients.at(-1), oldClient);
    assert.equal(sql.connectionManager.pool.using, 0);
});

test('a warm-cache supplemental query destroys its stalled socket without resetting Bloom history, then recovers', { timeout: 5000 }, async t => {
    const fault = await startMysqlFaultServer(t);
    const { database, clients, sql } = openDatabase(t, fault);
    await database.check();
    const oldClient = clients.at(-1);
    const cache = new MemoryCache();
    const metrics = new RandomMetrics();
    const history = emptyHistory();
    for (let id = 10; id < 30; id++) appendHistory(history, id);
    const batch = Array.from({ length: 8 }, (_, i) => ({ id: i + 10, name: 'seen site', link: 'https://seen.example', tag: 'blog' }));
    cache.pools.set(cacheKey('blog'), { batches: [JSON.stringify(batch), JSON.stringify(batch)], expires: 30000 });
    const candidateSource = createPrefetchSource({ cache, metrics, prefetchCandidates: database.prefetchCandidates });
    const app = createMvpApp({ database, cache, candidateSource, metrics, logger });
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const headers = { Cookie: `_tvl_mvp=${encodeURIComponent(serializeHistory(history, Math.floor(Date.now() / 1000)))}` };
    fault.stallCandidates = true;
    const failed = await get(server, '/random?tag=blog', headers);
    assert.equal(failed.status, 503);
    assert.equal(failed.headers['set-cookie'], undefined);
    assert.equal(oldClient.stream.destroyed, true);
    assert.equal(sql.connectionManager.pool.using, 0);
    assert.equal(sql.connectionManager.pool.size, 0);
    const failedStats = metrics.snapshot();
    assert.equal(failedStats.random_resample_queries_total, 1);
    assert.equal(failedStats.random_resample_errors_total, 1);
    assert.equal(failedStats.random_fallback_total, 0);
    assert.equal(failedStats.random_history_relaxations_total, 0);
    assert.equal(failedStats.random_history_resets_total, 0);
    assert.equal(failedStats.random_resample_unresolved_total, 0);
    assert.equal(failedStats.random_prefetch_query_duration_seconds.count, 0);
    assert.equal(failedStats.random_resample_query_duration_seconds.count, 1);
    assert.equal(failedStats.random_cache_hits_total, 1);

    fault.stallCandidates = false;
    const recovered = await get(server, '/random?tag=blog', headers);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.json().data[0].id, 1);
    assert.notEqual(clients.at(-1), oldClient);
    const rawState = recovered.headers['set-cookie'][0].split(';')[0].split('=').slice(1).join('=');
    const updated = loadHistory(decodeURIComponent(rawState), Math.floor(Date.now() / 1000));
    assert.equal(updated.n, 1);
    assert.equal(updated.lastId, 1);
    assert.equal(updated.current.has(1), true);
    for (let id = 10; id < 30; id++) assert.equal(updated.previous.has(id), true);
    assert.equal(Object.hasOwn(JSON.parse(decodeURIComponent(rawState)), 'ids'), false);
    const finalStats = metrics.snapshot();
    assert.equal(finalStats.random_cache_hits_total, 2);
    assert.equal(finalStats.random_query_duration_seconds.count, 2);
    assert.equal(finalStats.random_resample_query_duration_seconds.count, 2);
    assert.equal(finalStats.random_resample_errors_total, 1);
    assert.equal(finalStats.random_fallback_total, 0);
    const candidateQueries = fault.queries.filter(statement => /ORDER BY RAND\(\)/.test(statement));
    assert.equal(candidateQueries.length, 2);
    assert.ok(candidateQueries.every(statement => /LIMIT 64;/.test(statement) && !/NOT IN|COUNT\(|OFFSET/.test(statement)));
});

test('a query queued behind a timed-out pool borrower obtains a new connection', { timeout: 5000 }, async t => {
    const fault = await startMysqlFaultServer(t);
    const { database, clients, sql } = openDatabase(t, fault);
    await database.check();
    const oldClient = clients.at(-1);
    fault.stallCandidates = true;
    const started = once(fault.events, 'candidate');
    const stalled = database.prefetchCandidates();
    // Attach the rejection handler before waiting on the protocol event.
    const outcome = stalled.then(value => ({ value }), error => ({ error }));
    await started;
    fault.stallCandidates = false;
    const queued = database.findCandidates();
    assert.equal(isClientTimeout((await outcome).error), true);
    assert.equal((await queued)[0].id, 1);
    assert.equal(oldClient.stream.destroyed, true);
    assert.notEqual(clients.at(-1), oldClient);
    assert.equal(sql.connectionManager.pool.using, 0);
});

test('session initialization and health checks also enforce destructive client deadlines', { timeout: 5000 }, async t => {
    const fault = await startMysqlFaultServer(t);
    const { database, clients, sql } = openDatabase(t, fault);
    fault.stallSessionSetup = true;
    await assert.rejects(database.check(), isClientTimeout);
    assert.equal(clients.at(-1).stream.destroyed, true);
    fault.stallSessionSetup = false;
    await database.check();
    fault.stallHealth = true;
    await assert.rejects(database.check(), isClientTimeout);
    assert.equal(clients.at(-1).stream.destroyed, true);
    assert.equal(sql.connectionManager.pool.using, 0);
    fault.stallHealth = false;
    await database.check();
});

test('prepared-statement setup is inside the deadline and closes the actual socket', { timeout: 5000 }, async t => {
    const fault = await startMysqlFaultServer(t);
    const guarded = createGuardedMysql({ queryTimeoutMs: 100, connectTimeoutMs: 1000 });
    const client = guarded.dialectModule.createConnection({ host: '127.0.0.1', port: fault.port, user: 'test' });
    client.on('error', () => {});
    t.after(() => { client.destroy(); client.stream.destroy(); });
    await once(client, 'connect');
    await assert.rejects(new Promise((resolve, reject) => {
        client.execute('SELECT ?', [1], (error, rows) => error ? reject(error) : resolve(rows));
    }), isClientTimeout);
    assert.equal(client.stream.destroyed, true);
    assert.equal(guarded.didTimeout(client), true);
});

test('partial handshake bytes cannot disable the client connection deadline', { timeout: 5000 }, async t => {
    const sockets = [];
    const server = net.createServer(socket => {
        sockets.push(socket); socket.on('error', () => {});
        socket.write(Buffer.from([1])); // Clears mysql2's native connect timer without completing a packet.
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { sockets.forEach(socket => socket.destroy()); server.close(resolve); }));
    const guarded = createGuardedMysql({ queryTimeoutMs: 100, connectTimeoutMs: 100 });
    const client = guarded.dialectModule.createConnection({ host: '127.0.0.1', port: server.address().port, connectTimeout: 1000 });
    const error = await new Promise(resolve => client.once('error', resolve));
    assert.equal(error.code, 'RANDOM_MYSQL_CLIENT_TIMEOUT');
    assert.equal(error.syscall, 'connect');
    assert.equal(client.stream.destroyed, true);
});

function fakeDriver() {
    const connection = new EventEmitter();
    connection.stream = new EventEmitter();
    connection.stream.destroy = () => { connection.stream.destroyed = true; };
    connection.destroy = () => { connection.closed = true; };
    return { connection, createConnection: () => connection };
}

test('late callbacks after destructive timeout are ignored and poisoned connections reject new work', async () => {
    const driver = fakeDriver();
    let delayedCallback;
    let dispatched = 0;
    driver.connection.query = (sql, callback) => { dispatched++; delayedCallback = callback; return new EventEmitter(); };
    driver.connection.execute = driver.connection.query;
    const guarded = createGuardedMysql({ queryTimeoutMs: 20 }, driver);
    const connection = guarded.dialectModule.createConnection({});
    connection.emit('connect');
    let completed = 0;
    const error = await new Promise(resolve => connection.query('SELECT 1', value => { completed++; resolve(value); }));
    assert.equal(error.code, 'RANDOM_MYSQL_CLIENT_TIMEOUT');
    assert.equal(connection.stream.destroyed, true);
    delayedCallback(null, [{ result: 'late' }]);
    delayedCallback(Error('late network failure'));
    assert.equal(completed, 1);
    const nextError = await new Promise(resolve => connection.query('SELECT 2', resolve));
    assert.equal(nextError.code, 'RANDOM_MYSQL_CLIENT_TIMEOUT');
    assert.equal(dispatched, 1);
});

test('successful operations clear their deadline instead of destroying an idle healthy connection', async () => {
    const driver = fakeDriver();
    driver.connection.query = (sql, callback) => { queueMicrotask(() => callback(null, [])); return new EventEmitter(); };
    driver.connection.execute = driver.connection.query;
    const guarded = createGuardedMysql({ queryTimeoutMs: 20 }, driver);
    const connection = guarded.dialectModule.createConnection({});
    connection.emit('connect');
    await new Promise((resolve, reject) => connection.query('SELECT 1', error => error ? reject(error) : resolve()));
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(connection.stream.destroyed, undefined);
    assert.equal(guarded.didTimeout(connection), false);
});

test('eight requests waiting for a stalled refill all release their slots and a later request recovers', { timeout: 5000 }, async t => {
    const fault = await startMysqlFaultServer(t);
    const { database, clients, sql } = openDatabase(t, fault);
    await database.check();
    const oldClient = clients.at(-1);
    const cache = new MemoryCache();
    const metrics = new RandomMetrics();
    const candidateSource = createPrefetchSource({ cache, metrics, prefetchCandidates: database.prefetchCandidates });
    const app = createMvpApp({ database, cache, candidateSource, metrics, maxInFlight: 8, logger });
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    let received = 0;
    let allReceived;
    const receivedEight = new Promise(resolve => { allReceived = resolve; });
    server.on('request', req => { if ((req.originalUrl || req.url) === '/random' && ++received === 8) allReceived(); });
    fault.stallCandidates = true;
    const requests = Array.from({ length: 8 }, () => get(server));
    await receivedEight;
    const busy = await get(server);
    assert.equal(busy.status, 503);
    assert.match(busy.body, /请求繁忙/);
    const results = await Promise.all(requests);
    assert.ok(results.every(result => result.status === 503));
    assert.equal(fault.candidateConnections.length, 1);
    assert.equal(oldClient.stream.destroyed, true);
    assert.equal(sql.connectionManager.pool.using, 0);
    assert.equal(cache.locks.size, 0);
    assert.equal(metrics.snapshot().random_query_duration_seconds.count, 1);
    assert.equal(metrics.snapshot().random_errors_total, 8);
    fault.stallCandidates = false;
    const recovered = await get(server);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.json().success, true);
    assert.equal(metrics.snapshot().random_cache_refills_total, 1);
    assert.equal(fault.candidateConnections.length, 2);
});

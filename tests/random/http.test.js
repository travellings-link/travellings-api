const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMvpApp } = require('../../mvp/random/app');
const { start } = require('../../mvp/random/index');
const { emptyHistory, serializeHistory, HISTORY_TTL_SECONDS } = require('../../modules/random/history');
const { BloomFilter } = require('../../modules/random/bloom');
const { MemoryCache } = require('./memoryCache');
const { createPrefetchSource } = require('../../modules/random/prefetch');
const { RandomMetrics } = require('../../modules/random/metrics');

const logger = { info() {}, error() {} };
const site = id => ({ id, name: `site ${id}`, link: `https://site${id}.example`, tag: 'blog' });
function request(server, path, headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path, headers, method, agent: false }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body,
                json: () => JSON.parse(body) }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function serve(t, database, options = {}) {
    const app = createMvpApp({ database: { kind: 'mock', check: async () => {}, ...database }, logger, ...options });
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    return server;
}
const cookie = raw => `_tvl_mvp=${encodeURIComponent(raw)}`;
const updatedState = res => JSON.parse(decodeURIComponent(res.headers['set-cookie'][0].split(';')[0].split('=').slice(1).join('=')));

test('HTTP random preserves the mainline response, tag filter, and exactly one query', async t => {
    const calls = [];
    const server = await serve(t, { findCandidates: async query => { calls.push(query); return [site(1), site(2)]; } });
    const first = await request(server, '/random?tag=blog');
    assert.equal(first.status, 200);
    assert.deepEqual(first.json(), { success: true, data: [{ id: 1, name: 'site 1', url: 'https://site1.example', tag: 'blog' }] });
    assert.deepEqual(calls, [{ tag: 'blog' }]);
    assert.match(first.headers['set-cookie'][0], /HttpOnly/);
    assert.match(first.headers['set-cookie'][0], /SameSite=Lax/);
    assert.match(first.headers['set-cookie'][0], /Path=\/random/);
    const second = await request(server, '/random', { Cookie: first.headers['set-cookie'][0].split(';')[0] });
    assert.equal(second.json().data[0].id, 2);
    assert.equal(calls.length, 2);
    const stats = (await request(server, '/stats')).json();
    assert.equal(stats.query_duration_source, 'mock');
    assert.equal(stats.metrics.random_requests_total, 2);
    assert.equal(stats.metrics.random_bloom_hits_total, 1);
    assert.equal(stats.metrics.random_query_duration_seconds.count, 2);
    assert.equal(stats.metrics.random_errors_total, 0);
});

test('valid saturated cookie uses same-batch fallback with one query and count one', async t => {
    let queries = 0;
    const server = await serve(t, { findCandidates: async () => { queries++; return [site(2), site(3)]; } });
    const history = { bloom: new BloomFilter(Buffer.alloc(40, 255)), n: 1, lastId: 2 };
    const res = await request(server, '/random', { Cookie: cookie(serializeHistory(history, Math.floor(Date.now() / 1000))) });
    assert.equal(res.json().data[0].id, 3);
    const saved = updatedState(res);
    assert.equal(saved.n, 1);
    assert.equal(saved.lastId, 3);
    assert.equal(BloomFilter.fromBase64(saved.bf).has(3), true);
    assert.equal(queries, 1);
    const metrics = (await request(server, '/stats')).json().metrics;
    assert.equal(metrics.random_fallback_total, 1);
    assert.equal(metrics.random_bloom_hits_total, 2);
    assert.equal(metrics.random_errors_total, 0);
});

test('expired and corrupted cookies do not preserve old lastId', async t => {
    let queries = 0;
    const server = await serve(t, { findCandidates: async () => { queries++; return [site(1), site(2)]; } });
    const history = emptyHistory();
    history.n = 1; history.lastId = 1; history.bloom.add(1);
    const expired = serializeHistory(history, Math.floor(Date.now() / 1000) - HISTORY_TTL_SECONDS);
    for (const raw of [expired, '{broken']) {
        const response = await request(server, '/random', { Cookie: cookie(raw) });
        assert.equal(response.json().data[0].id, 1);
        assert.equal(updatedState(response).n, 1);
    }
    assert.equal(queries, 2);
    const metrics = (await request(server, '/stats')).json().metrics;
    assert.equal(metrics.random_fallback_total, 0);
    assert.equal(metrics.random_errors_total, 0);
});

test('empty pools are not errors or fallback and do not write a cookie', async t => {
    const server = await serve(t, { findCandidates: async () => [] });
    const response = await request(server, '/random');
    assert.equal(response.status, 200);
    assert.equal(response.json().success, false);
    assert.equal(response.headers['set-cookie'], undefined);
    const metrics = (await request(server, '/stats')).json().metrics;
    assert.equal(metrics.random_requests_total, 1);
    assert.equal(metrics.random_query_duration_seconds.count, 1);
    assert.equal(metrics.random_fallback_total, 0);
    assert.equal(metrics.random_errors_total, 0);
});

test('failed candidate queries are timed and counted once, with no retry or leaked error', async t => {
    let queries = 0;
    const server = await serve(t, { findCandidates: async () => { queries++; throw Error('private database detail'); } });
    const response = await request(server, '/random');
    assert.equal(response.status, 503);
    assert.doesNotMatch(response.body, /private database/);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(queries, 1);
    const metrics = (await request(server, '/stats')).json().metrics;
    assert.equal(metrics.random_errors_total, 1);
    assert.equal(metrics.random_query_duration_seconds.count, 1);
});

test('health and statistics do not change random metrics; health reports database failure', async t => {
    let checks = 0;
    let failing = false;
    const server = await serve(t, { findCandidates: async () => [site(1)], check: async () => {
        checks++; if (failing) throw Error('private connection detail');
    } });
    assert.equal((await request(server, '/health')).status, 200);
    failing = true;
    const health = await request(server, '/health');
    assert.equal(health.status, 503);
    assert.doesNotMatch(health.body, /private connection/);
    assert.equal(checks, 2);
    const stats = (await request(server, '/stats')).json();
    assert.equal(stats.metrics.random_requests_total, 0);
    assert.equal(stats.metrics.random_errors_total, 0);
    assert.equal(stats.metrics.random_query_duration_seconds.count, 0);
    const prom = await request(server, '/metrics');
    assert.match(prom.headers['content-type'], /^text\/plain;/);
    assert.match(prom.headers['content-type'], /version=0\.0\.4/);
    assert.match(prom.body, /random_requests_total 0/);
    assert.match(prom.body, /# TYPE random_query_duration_seconds histogram/);
    assert.equal(prom.headers['cache-control'], 'no-store');
});

test('the MVP exposes no mainline business routes and rejects invalid tag shapes before querying', async t => {
    let queries = 0;
    const server = await serve(t, { findCandidates: async () => { queries++; return [site(1)]; } });
    for (const path of ['/all', '/login', '/user', '/report', '/action', '/']) {
        assert.equal((await request(server, path)).status, 404);
    }
    assert.equal((await request(server, '/random?tag=a&tag=b')).status, 400);
    assert.equal((await request(server, '/random?tag[x]=a')).status, 400);
    assert.equal((await request(server, `/random?tag=${'a'.repeat(256)}`)).status, 400);
    assert.equal((await request(server, '/random', {}, 'POST')).status, 404);
    assert.equal((await request(server, '/random', {}, 'HEAD')).status, 405);
    assert.equal(queries, 0);
});

test('cookie Secure is explicit behind HTTPS proxies and CORS preserves the allowed origin', async t => {
    const server = await serve(t, { findCandidates: async () => [site(1)] }, { cookieSecure: true });
    const response = await request(server, '/random', { Origin: 'https://www.travellings.cn', 'X-Forwarded-Proto': 'https' });
    assert.match(response.headers['set-cookie'][0], /; Secure;/);
    assert.equal(response.headers['access-control-allow-origin'], 'https://www.travellings.cn');
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
    assert.equal((await request(server, '/stats', { Origin: 'https://example.test' })).headers['access-control-allow-origin'], undefined);
});

test('in-flight limit rejects overload without querying, then releases the slot', { timeout: 5000 }, async t => {
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let queries = 0;
    const server = await serve(t, { findCandidates: async () => {
        queries++; entered(); await gate; return [site(1)];
    } }, { maxInFlight: 1 });
    const first = request(server, '/random');
    try {
        await started;
        const busy = await request(server, '/random');
        assert.equal(busy.status, 503);
        assert.equal(busy.headers['retry-after'], '1');
        assert.equal(queries, 1);
    } finally { release(); }
    assert.equal((await first).status, 200);
    assert.equal((await request(server, '/random')).status, 200);
    const metrics = (await request(server, '/stats')).json().metrics;
    assert.equal(metrics.random_requests_total, 3);
    assert.equal(metrics.random_query_duration_seconds.count, 2);
    assert.equal(metrics.random_errors_total, 0);
});

test('entry checks the database before listening and closes it when startup fails', async () => {
    let closed = 0;
    await assert.rejects(start({ config: { database: {} }, logger, createDatabase: () => ({
        check: async () => { throw Error('unavailable'); }, close: async () => { closed++; },
    }) }), /unavailable/);
    assert.equal(closed, 1);
});

test('entry has an independent listener and idempotent graceful shutdown', async () => {
    let closed = 0;
    const cache = new MemoryCache();
    const runtime = await start({ config: { host: '127.0.0.1', port: 0, database: { queryTimeoutMs: 2000 }, redis: { timeoutMs: 1000 }, cacheTtlSeconds: 30 }, logger,
        createDatabase: () => ({ kind: 'mock', prefetchCandidates: async () => [site(1)], check: async () => {}, close: async () => { closed++; } }),
        createCache: () => cache,
    });
    try {
        assert.equal((await request(runtime.server, '/random')).status, 200);
    } finally {
        const stopping = runtime.close();
        assert.equal(runtime.close(), stopping);
        await stopping;
    }
    assert.equal(closed, 1);
    assert.equal(cache.closed, 1);
});

test('cached HTTP requests keep MySQL query metrics separate from Redis hits', async t => {
    const cache = new MemoryCache();
    const metrics = new RandomMetrics();
    let queries = 0;
    const candidateSource = createPrefetchSource({ cache, metrics, prefetchCandidates: async () => {
        queries++; return Array.from({ length: 64 }, (_, i) => site(i + 1));
    } });
    const server = await serve(t, {}, { cache, metrics, candidateSource });
    for (let requestNo = 0; requestNo < 8; requestNo++) {
        assert.equal((await request(server, '/random')).status, 200);
    }
    const stats = (await request(server, '/stats')).json();
    assert.equal(stats.candidate_source, 'redis-prefetch');
    assert.equal(stats.cache.database, 5);
    assert.equal(stats.metrics.random_requests_total, 8);
    assert.equal(stats.metrics.random_query_duration_seconds.count, 1);
    assert.equal(stats.metrics.random_cache_hits_total, 7);
    assert.equal(queries, 1);
    assert.equal((await request(server, '/health')).json().redis, 'ready');
    cache.online = false;
    const health = await request(server, '/health');
    assert.equal(health.status, 503);
    assert.equal(health.json().database, 'ready');
    assert.equal(health.json().redis, 'unavailable');
    assert.equal((await request(server, '/random')).status, 503);
    assert.equal(queries, 1);
});

test('Redis startup failure closes both resources before opening a listener', async () => {
    let closed = 0;
    const cache = new MemoryCache();
    cache.online = false;
    await assert.rejects(start({ config: { database: {}, redis: {} }, logger,
        createDatabase: () => ({ check: async () => {}, close: async () => { closed++; } }),
        createCache: () => cache,
    }), /Redis unavailable/);
    assert.equal(closed, 1);
    assert.equal(cache.closed, 1);
});

test('a Redis cleanup failure cannot prevent MySQL cleanup or hide the startup error', async () => {
    let closed = 0;
    await assert.rejects(start({ config: { database: {}, redis: {} }, logger,
        createDatabase: () => ({ check: async () => {}, close: async () => { closed++; } }),
        createCache: () => ({ connect: async () => { throw Error('Redis startup failed'); },
            close: async () => { throw Error('Redis cleanup failed'); } }),
    }), /Redis startup failed/);
    assert.equal(closed, 1);
});

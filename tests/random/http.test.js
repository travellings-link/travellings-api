const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMvpApp } = require('../../mvp/random/app');
const { start } = require('../../mvp/random/index');
const { emptyHistory, appendHistory, loadHistory, serializeHistory, HISTORY_TTL_SECONDS } = require('../../modules/random/history');
const { MemoryCache } = require('./memoryCache');
const { createPrefetchSource, cacheKey } = require('../../modules/random/prefetch');
const { RandomMetrics } = require('../../modules/random/metrics');
const { createResampleSource } = require('../../modules/random/resample');

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
    const app = createMvpApp({ database: { kind: 'mock', check: async () => {}, resampleCandidates: async () => [], ...database }, logger, ...options });
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    return server;
}
function visited(...ids) {
    const history = emptyHistory();
    ids.forEach(id => appendHistory(history, id));
    return history;
}
const cookie = raw => `_tvl_mvp=${encodeURIComponent(raw)}`;
const updatedState = res => JSON.parse(decodeURIComponent(res.headers['set-cookie'][0].split(';')[0].split('=').slice(1).join('=')));
const restoredState = res => loadHistory(JSON.stringify(updatedState(res)), Math.floor(Date.now() / 1000));

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
    assert.equal(stats.algorithm.history_version, 3);
    assert.equal(stats.metrics.random_requests_total, 2);
    assert.equal(stats.metrics.random_bloom_hits_total, 1);
    assert.equal(stats.metrics.random_query_duration_seconds.count, 2);
    assert.equal(stats.metrics.random_errors_total, 0);
});

test('one supplemental sample is filtered locally across batches and never clears either generation', async t => {
    let queries = 0;
    const scopes = [];
    const history = visited(...Array.from({ length: 20 }, (_, i) => i + 1));
    const server = await serve(t, {
        findCandidates: async () => { queries++; return [site(2), site(3)]; },
        resampleCandidates: async query => { queries++; scopes.push(query); return Array.from({ length: 64 }, (_, i) => site(i + 1)); },
    });
    const res = await request(server, '/random?tag=life', { Cookie: cookie(serializeHistory(history, Math.floor(Date.now() / 1000))) });
    assert.equal(res.status, 200);
    assert.equal(res.json().data[0].id, 21);
    const saved = restoredState(res);
    assert.equal(saved.previous.has(1), true);
    assert.equal(saved.previous.has(20), true);
    assert.equal(saved.current.has(21), true);
    assert.equal(saved.n, 1);
    assert.equal(saved.lastId, 21);
    assert.deepEqual(scopes, [{ tag: 'life' }]);
    assert.equal(queries, 2);
    const metrics = (await request(server, '/stats')).json().metrics;
    assert.equal(metrics.random_fallback_total, 0);
    assert.equal(metrics.random_bloom_hits_total, 22);
    assert.equal(metrics.random_resample_attempts_total, 1);
    assert.equal(metrics.random_resample_queries_total, 1);
    assert.equal(metrics.random_query_duration_seconds.count, 2);
    assert.equal(metrics.random_resample_query_duration_seconds.count, 1);
    assert.equal(metrics.random_errors_total, 0);
});

test('an empty or fully filtered supplemental sample relaxes same-batch history to return successfully', async t => {
    let samples = 0;
    const history = visited(1, 2, 3);
    const original = serializeHistory(history, Math.floor(Date.now() / 1000));
    const server = await serve(t, {
        findCandidates: async () => [site(1), site(2)],
        resampleCandidates: async () => ++samples === 1 ? [site(1), site(2), site(3)] : [],
    }, { resample: { maxInFlight: 1, ratePerSecond: 100, burst: 10 } });
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await request(server, '/random', { Cookie: cookie(original) });
        assert.equal(response.status, 200);
        assert.equal(response.json().data[0].id, 1);
        assert.equal(updatedState(response).n, 1);
        assert.equal(updatedState(response).lastId, 1);
        assert.equal(restoredState(response).current.has(1), true);
        assert.ok(restoredState(response).previous.bytes.every(byte => byte === 0));
    }
    const metrics = (await request(server, '/stats')).json().metrics;
    assert.equal(samples, 2);
    assert.equal(metrics.random_resample_unresolved_total, 2);
    assert.equal(metrics.random_fallback_total, 2);
    assert.equal(metrics.random_history_relaxations_total, 2);
    assert.equal(metrics.random_history_resets_total, 2);
    assert.equal(metrics.random_errors_total, 0);
    assert.ok(!Object.hasOwn(metrics, 'random_history_exhausted_total'));
});

test('expired, damaged, old Bloom and exact FIFO cookies discard all historical rejection', async t => {
    let queries = 0;
    const server = await serve(t, { findCandidates: async () => { queries++; return [site(1), site(2)]; } });
    const now = Math.floor(Date.now() / 1000);
    const expired = serializeHistory(visited(1), now - HISTORY_TTL_SECONDS);
    const oldBloom = JSON.stringify({ v: 1, bf: Buffer.alloc(40, 255).toString('base64'), n: 1, lastId: 1, t: now });
    const oldFifo = JSON.stringify({ v: 2, ids: [1, 2], t: now });
    for (const raw of [expired, '{broken', oldBloom, oldFifo]) {
        const response = await request(server, '/random', { Cookie: cookie(raw) });
        assert.equal(response.json().data[0].id, 1);
        assert.equal(updatedState(response).n, 1);
        assert.equal(updatedState(response).lastId, 1);
        assert.equal(updatedState(response).v, 3);
        assert.equal(restoredState(response).current.has(1), true);
    }
    assert.equal(queries, 4);
    assert.equal((await request(server, '/stats')).json().metrics.random_fallback_total, 0);
});

test('a failed supplemental query returns 503 without allowing repetition or writing a cookie', async t => {
    let queries = 0;
    const server = await serve(t, {
        findCandidates: async () => [site(1)],
        resampleCandidates: async () => { queries++; throw Error('private SQL failure'); },
    });
    const response = await request(server, '/random', { Cookie: cookie(serializeHistory(visited(1), Math.floor(Date.now() / 1000))) });
    assert.equal(response.status, 503);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.doesNotMatch(response.body, /private SQL failure/);
    assert.equal(queries, 1);
    const metrics = (await request(server, '/stats')).json().metrics;
    assert.equal(metrics.random_fallback_total, 0);
    assert.equal(metrics.random_resample_unresolved_total, 0);
    assert.equal(metrics.random_resample_errors_total, 1);
    assert.equal(metrics.random_errors_total, 1);
});

test('an invalid supplemental result cannot silently violate the Rolling Bloom filter', async t => {
    const server = await serve(t, { findCandidates: async () => [site(1)], resampleCandidates: async () => [{ id: 'bad' }] });
    const response = await request(server, '/random', { Cookie: cookie(serializeHistory(visited(1), Math.floor(Date.now() / 1000))) });
    assert.equal(response.status, 503);
    assert.equal(response.headers['set-cookie'], undefined);
    const metrics = (await request(server, '/stats')).json().metrics;
    assert.equal(metrics.random_resample_errors_total, 1);
    assert.equal(metrics.random_resample_unresolved_total, 0);
});

test('a draining resample source remains 503 and cannot be mistaken for a budget fallback', async t => {
    const server = await serve(t, { findCandidates: async () => [site(1)] }, {
        resampleSource: { findCandidates: async () => {
            const error = Error('closing'); error.code = 'RANDOM_RESAMPLE_CLOSING'; throw error;
        } },
    });
    const response = await request(server, '/random', {
        Cookie: cookie(serializeHistory(visited(1), Math.floor(Date.now() / 1000))),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers['set-cookie'], undefined);
    const metrics = (await request(server, '/stats')).json().metrics;
    assert.equal(metrics.random_fallback_total, 0);
    assert.equal(metrics.random_history_relaxations_total, 0);
    assert.equal(metrics.random_history_resets_total, 0);
});

test('saturated generations reset only for a successful same-batch selection and immediately record its ID', async t => {
    const history = visited(1);
    history.current.bytes.fill(255);
    history.previous.bytes.fill(255);
    const server = await serve(t, {
        findCandidates: async () => [site(1), site(2)],
        resampleCandidates: async () => [site(1), site(2), site(3)],
    });
    const response = await request(server, '/random', {
        Cookie: cookie(serializeHistory(history, Math.floor(Date.now() / 1000))),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json().data[0].id, 2);
    const state = restoredState(response);
    assert.equal(state.n, 1);
    assert.equal(state.lastId, 2);
    assert.equal(state.current.toBase64(), visited(2).current.toBase64());
    assert.ok(state.previous.bytes.every(byte => byte === 0));
    const metrics = (await request(server, '/stats')).json().metrics;
    assert.equal(metrics.random_fallback_total, 1);
    assert.equal(metrics.random_history_relaxations_total, 1);
    assert.equal(metrics.random_history_resets_total, 1);
});

test('different tags share both Bloom generations and successes refresh the fifteen-day lifetime', async t => {
    const calls = [];
    const server = await serve(t, { findCandidates: async query => {
        calls.push(query); return query.tag === 'life' ? [site(1)] : [site(1), site(2)];
    } });
    const life = await request(server, '/random?tag=life');
    const blog = await request(server, '/random?tag=blog', { Cookie: life.headers['set-cookie'][0].split(';')[0] });
    assert.equal(blog.json().data[0].id, 2);
    const restored = restoredState(blog);
    assert.equal(restored.current.has(1), true);
    assert.equal(restored.current.has(2), true);
    assert.equal(restored.n, 2);
    assert.deepEqual(calls, [{ tag: 'life' }, { tag: 'blog' }]);
    assert.match(blog.headers['set-cookie'][0], /Max-Age=1296000/);
});

test('resample concurrency refusal returns a same-batch fallback and releases its permit on completion', { timeout: 5000 }, async t => {
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let queries = 0;
    const server = await serve(t, {
        findCandidates: async () => [site(1)],
        resampleCandidates: async () => { queries++; entered(); await gate; return [site(2)]; },
    }, { resample: { maxInFlight: 1, ratePerSecond: 100, burst: 10 } });
    const headers = { Cookie: cookie(serializeHistory(visited(1), Math.floor(Date.now() / 1000))) };
    const first = request(server, '/random', headers);
    try {
        await started;
        const busy = await request(server, '/random', headers);
        assert.equal(busy.status, 200);
        assert.equal(busy.json().data[0].id, 1);
        assert.equal(updatedState(busy).n, 1);
        assert.equal(queries, 1);
    } finally { release(); }
    assert.equal((await first).status, 200);
    assert.equal((await request(server, '/random', headers)).status, 200);
    const metrics = (await request(server, '/stats')).json().metrics;
    assert.equal(metrics.random_resample_rejected_total, 1);
    assert.equal(metrics.random_resample_queries_total, 2);
    assert.equal(metrics.random_fallback_total, 1);
    assert.equal(metrics.random_history_relaxations_total, 1);
    assert.equal(metrics.random_history_resets_total, 1);
    assert.equal(metrics.random_resample_unresolved_total, 0);
});

test('a one-site pool keeps succeeding after its supplemental rate budget is exhausted', async t => {
    const metrics = new RandomMetrics();
    let queries = 0;
    const resampleSource = createResampleSource({ metrics, now: () => 0, resampleCandidates: async () => {
        queries++; return [site(1)];
    } });
    const server = await serve(t, { findCandidates: async () => [site(1)] }, { metrics, resampleSource });
    let cookieHeader;
    for (let visit = 0; visit < 30; visit++) {
        const response = await request(server, '/random', cookieHeader ? { Cookie: cookieHeader } : {});
        assert.equal(response.status, 200);
        assert.equal(response.json().data[0].id, 1);
        assert.equal(updatedState(response).n, 1);
        assert.equal(restoredState(response).current.has(1), true);
        cookieHeader = response.headers['set-cookie'][0].split(';')[0];
    }
    const stats = metrics.snapshot();
    assert.equal(queries, 2);
    assert.equal(stats.random_resample_queries_total, 2);
    assert.equal(stats.random_resample_rejected_total, 27);
    assert.equal(stats.random_resample_unresolved_total, 2);
    assert.equal(stats.random_fallback_total, 29);
    assert.equal(stats.random_history_relaxations_total, 29);
    assert.equal(stats.random_history_resets_total, 29);
    assert.equal(stats.random_errors_total, 0);
    await resampleSource.close();
});

test('generation overlap relaxes previous history while preserving current visits and avoiding lastId', async t => {
    const history = visited(...Array.from({ length: 21 }, (_, i) => i + 1));
    const server = await serve(t, {
        findCandidates: async () => [site(21), site(2), site(1)],
        resampleCandidates: async () => Array.from({ length: 21 }, (_, i) => site(i + 1)),
    });
    // ID 1 has left an exact twenty-visit queue, but its generation is retained.
    const response = await request(server, '/random', {
        Cookie: cookie(serializeHistory(history, Math.floor(Date.now() / 1000))),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json().data[0].id, 2);
    const state = restoredState(response);
    assert.equal(state.n, 2);
    assert.equal(state.lastId, 2);
    assert.equal(state.current.has(21), true);
    assert.equal(state.current.has(2), true);
    assert.ok(state.previous.bytes.every(byte => byte === 0));
    const metrics = (await request(server, '/stats')).json().metrics;
    assert.equal(metrics.random_resample_queries_total, 1);
    assert.equal(metrics.random_resample_unresolved_total, 1);
    assert.equal(metrics.random_fallback_total, 1);
    assert.equal(metrics.random_history_relaxations_total, 1);
    assert.equal(metrics.random_history_resets_total, 0);
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

test('a Redis cache hit may issue one supplemental sample without publishing its result', async t => {
    const cache = new MemoryCache();
    const metrics = new RandomMetrics();
    const key = cacheKey('life');
    cache.pools.set(key, { batches: [JSON.stringify([site(1), site(2)])], expires: 30000 });
    let prefetchQueries = 0;
    let resampleQueries = 0;
    const candidateSource = createPrefetchSource({ cache, metrics, prefetchCandidates: async () => {
        prefetchQueries++; return [site(1), site(2)];
    } });
    const server = await serve(t, { resampleCandidates: async query => {
        resampleQueries++;
        assert.deepEqual(query, { tag: 'life' });
        return [site(3)];
    } }, { cache, metrics, candidateSource });
    const response = await request(server, '/random?tag=life', {
        Cookie: cookie(serializeHistory(visited(1, 2), Math.floor(Date.now() / 1000))),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json().data[0].id, 3);
    assert.equal(restoredState(response).current.has(3), true);
    assert.equal(updatedState(response).n, 3);
    assert.equal(prefetchQueries, 0);
    assert.equal(resampleQueries, 1);
    assert.deepEqual(cache.pools.get(key).batches, []);
    const stats = metrics.snapshot();
    assert.equal(stats.random_cache_hits_total, 1);
    assert.equal(stats.random_cache_refills_total, 0);
    assert.equal(stats.random_query_duration_seconds.count, 1);
    assert.equal(stats.random_prefetch_query_duration_seconds.count, 0);
    assert.equal(stats.random_resample_query_duration_seconds.count, 1);
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

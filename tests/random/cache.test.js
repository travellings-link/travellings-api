const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRedisCache } = require('../../mvp/random/redis');
const { createPrefetchSource, cacheKey } = require('../../modules/random/prefetch');
const { RandomMetrics } = require('../../modules/random/metrics');
const { MemoryCache } = require('./memoryCache');

const sites = (n = 64, start = 1) => Array.from({ length: n }, (_, i) => ({ id: start + i, name: 'site', link: 'https://example.test', tag: 'blog' }));

test('64 SQL samples supply eight distinct consumed batches; the next request refills', async () => {
    let queries = 0;
    const metrics = new RandomMetrics();
    const source = createPrefetchSource({ cache: new MemoryCache(), metrics,
        prefetchCandidates: async () => sites(64, queries++ * 64 + 1) });
    const batches = [];
    for (let i = 0; i < 8; i++) batches.push(await source.findCandidates());
    assert.ok(batches.every(batch => batch.length === 8));
    assert.equal(new Set(batches.flat().map(row => row.id)).size, 64);
    assert.equal(queries, 1);
    assert.equal((await source.findCandidates())[0].id, 65);
    assert.equal(queries, 2);
    const stats = metrics.snapshot();
    assert.equal(stats.random_cache_hits_total, 7);
    assert.equal(stats.random_cache_misses_total, 2);
    assert.equal(stats.random_cache_refills_total, 2);
    assert.equal(stats.random_query_duration_seconds.count, 2);
});

test('concurrent cold requests share SQL refill but never share the same batch', async () => {
    const cache = new MemoryCache();
    let queries = 0;
    const metrics = new RandomMetrics();
    const source = createPrefetchSource({ cache, metrics,
        prefetchCandidates: async () => { queries++; await new Promise(resolve => setImmediate(resolve)); return sites(); } });
    const batches = await Promise.all(Array.from({ length: 8 }, () => source.findCandidates()));
    assert.equal(queries, 1);
    assert.equal(new Set(batches.flat().map(row => row.id)).size, 64);
    assert.equal(metrics.snapshot().random_query_duration_seconds.count, 1);
});

test('different service instances coordinate refill using the shared token lock', async () => {
    const cache = new MemoryCache();
    let queries = 0;
    const query = async () => { queries++; await new Promise(resolve => setImmediate(resolve)); return sites(); };
    const first = createPrefetchSource({ cache, metrics: new RandomMetrics(), prefetchCandidates: query });
    const second = createPrefetchSource({ cache, metrics: new RandomMetrics(), prefetchCandidates: query });
    const batches = await Promise.all([first.findCandidates(), second.findCandidates()]);
    assert.equal(queries, 1);
    assert.equal(new Set(batches.flat().map(row => row.id)).size, 16);
});

test('cache expiry triggers a new sample and tag scopes remain isolated', async () => {
    const cache = new MemoryCache();
    const tags = [];
    const source = createPrefetchSource({ cache, metrics: new RandomMetrics(), ttlSeconds: 30,
        prefetchCandidates: async ({ tag }) => { tags.push(tag); return sites(); } });
    await source.findCandidates({ tag: 'a' });
    await source.findCandidates({ tag: 'b' });
    await source.findCandidates({ tag: 'a' });
    assert.deepEqual(tags, ['a', 'b']);
    cache.now = 30001;
    await source.findCandidates({ tag: 'a' });
    assert.deepEqual(tags, ['a', 'b', 'a']);
    assert.notEqual(cacheKey('a'), cacheKey('b'));
    assert.equal(cacheKey(''), cacheKey(undefined));
    assert.notEqual(cacheKey('all'), cacheKey(undefined));
});

test('small complete pools and empty results are cached without inventing candidates', async () => {
    for (const size of [0, 1, 3, 20, 63]) {
        let queries = 0;
        const source = createPrefetchSource({ cache: new MemoryCache(), metrics: new RandomMetrics(),
            prefetchCandidates: async () => { queries++; return sites(size); } });
        for (let request = 0; request < 8; request++) {
            const batch = await source.findCandidates();
            assert.equal(batch.length, Math.min(size, 8));
            assert.equal(new Set(batch.map(row => row.id)).size, batch.length);
            assert.ok(batch.every(row => row.id >= 1 && row.id <= size));
        }
        assert.equal(queries, 1);
    }
});

test('Redis outage never falls through to MySQL; recovery permits a bounded refill', async () => {
    const cache = new MemoryCache();
    cache.online = false;
    let queries = 0;
    const source = createPrefetchSource({ cache, metrics: new RandomMetrics(), prefetchCandidates: async () => { queries++; return sites(); } });
    await assert.rejects(source.findCandidates(), /Redis unavailable/);
    assert.equal(queries, 0);
    cache.online = true;
    assert.equal((await source.findCandidates()).length, 8);
    assert.equal(queries, 1);
});

test('failed SQL is timed once and its lease is released for the next request', async () => {
    const cache = new MemoryCache();
    const metrics = new RandomMetrics();
    let queries = 0;
    const source = createPrefetchSource({ cache, metrics, prefetchCandidates: async () => {
        queries++; if (queries === 1) throw Error('SQL unavailable'); return sites();
    } });
    await assert.rejects(source.findCandidates(), /SQL unavailable/);
    assert.equal(cache.locks.size, 0);
    await source.findCandidates();
    assert.equal(queries, 2);
    assert.equal(metrics.snapshot().random_query_duration_seconds.count, 2);
    assert.equal(metrics.snapshot().random_cache_refills_total, 1);
});

test('an expired owner cannot publish or delete another owner\'s lease', async () => {
    const cache = new MemoryCache();
    const lockKey = `${cacheKey()}:lock`;
    let queries = 0;
    const source = createPrefetchSource({ cache, metrics: new RandomMetrics(), prefetchCandidates: async () => {
        queries++; cache.locks.set(lockKey, { token: 'new-owner', expires: 999999 }); return sites();
    } });
    await assert.rejects(source.findCandidates(), /lease expired/);
    assert.equal(queries, 1);
    assert.equal(cache.locks.get(lockKey).token, 'new-owner');
});

test('lock contention times out without a duplicate SQL query', async () => {
    const cache = new MemoryCache();
    await cache.acquireLock(`${cacheKey()}:lock`, 'other-instance', 15000);
    let queries = 0;
    const source = createPrefetchSource({ cache, metrics: new RandomMetrics(), waitMs: 0,
        prefetchCandidates: async () => { queries++; return sites(); } });
    await assert.rejects(source.findCandidates(), /refill timed out/);
    assert.equal(queries, 0);
});

test('malformed cached rows fail closed without extra SQL', async () => {
    const cache = new MemoryCache();
    cache.pools.set(cacheKey(), { batches: ['{"id":"bad"}'], expires: 30000 });
    let queries = 0;
    const source = createPrefetchSource({ cache, metrics: new RandomMetrics(), prefetchCandidates: async () => { queries++; return sites(); } });
    await assert.rejects(source.findCandidates(), /Invalid cached candidate/);
    assert.equal(queries, 0);
});

test('Redis client always selects DB 5, rejects offline queues, and limits command wait', async () => {
    const fake = new EventEmitter();
    fake.isOpen = false;
    fake.connect = async () => { fake.isOpen = true; };
    fake.disconnect = async () => { fake.isOpen = false; };
    fake.ping = () => new Promise(() => {});
    let options;
    const cache = createRedisCache({ host: '127.0.0.1', port: 6379, database: 0, timeoutMs: 20 }, { error() {} }, config => {
        options = config; return fake;
    });
    assert.equal(options.database, 5);
    assert.equal(options.disableOfflineQueue, true);
    assert.equal(options.commandsQueueMaxLength, 64);
    await cache.connect();
    await assert.rejects(cache.check(), /Redis operation timed out/);
    await cache.close();
    assert.equal(fake.isOpen, false);
});

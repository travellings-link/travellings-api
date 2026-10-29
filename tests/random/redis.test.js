const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createClient } = require('redis');
const { createRedisCache } = require('../../mvp/random/redis');
const { createPrefetchSource, cacheKey } = require('../../modules/random/prefetch');
const { RandomMetrics } = require('../../modules/random/metrics');

test('real Redis: DB 5 isolation, atomic batch consumption, leases, and expiration (SQL simulated)', {
    skip: process.env.RANDOM_MVP_REDIS_TEST !== '1',
}, async t => {
    const config = {
        host: process.env.RANDOM_MVP_REDIS_HOST || '127.0.0.1',
        port: Number(process.env.RANDOM_MVP_REDIS_PORT || 6379),
        username: process.env.RANDOM_MVP_REDIS_USERNAME || '',
        password: process.env.RANDOM_MVP_REDIS_PASSWORD || '',
        timeoutMs: 2000,
    };
    const cache = createRedisCache(config, { error() {} });
    const db0 = createClient({ socket: { host: config.host, port: config.port, reconnectStrategy: false },
        username: config.username || undefined, password: config.password || undefined, database: 0 });
    db0.on('error', () => {});
    t.after(async () => {
        await cache.close();
        if (db0.isOpen) await db0.disconnect();
    });
    await cache.connect();
    await db0.connect();
    await cache.check();
    const tag = `integration-${randomUUID()}`;
    let queries = 0;
    const source = createPrefetchSource({ cache, metrics: new RandomMetrics(), ttlSeconds: 1,
        prefetchCandidates: async () => { queries++; return Array.from({ length: 64 }, (_, i) => ({
            id: i + 1, name: 'test', link: 'https://example.test', tag,
        })); },
    });
    const batches = await Promise.all(Array.from({ length: 8 }, () => source.findCandidates({ tag })));
    assert.equal(queries, 1);
    assert.equal(new Set(batches.flat().map(row => row.id)).size, 64);
    assert.equal(await db0.exists(cacheKey(tag)), 0);

    const key = cacheKey(`${tag}-ttl`);
    const lockKey = `${key}:lock`;
    assert.equal(await cache.acquireLock(lockKey, 'owner', 5000), 'OK');
    assert.equal(await cache.publishBatches(key, lockKey, 'wrong-owner', ['[]'], 1), 0);
    await cache.releaseLock(lockKey, 'wrong-owner');
    assert.equal(await cache.acquireLock(lockKey, 'second-owner', 5000), null);
    assert.equal(await cache.publishBatches(key, lockKey, 'owner', ['[]', '[]'], 1), 1);
    assert.equal(await cache.popBatch(key), '[]');
    assert.equal(await db0.exists(key), 0);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(await cache.popBatch(key), null);
});

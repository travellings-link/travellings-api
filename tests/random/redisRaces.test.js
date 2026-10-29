const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const http = require('node:http');
const { createRedisCache } = require('../../mvp/random/redis');
const { createPrefetchSource, cacheKey } = require('../../modules/random/prefetch');
const { RandomMetrics } = require('../../modules/random/metrics');
const { start } = require('../../mvp/random/index');
const { MemoryCache } = require('./memoryCache');

const logger = { info() {}, error() {} };
const sites = () => Array.from({ length: 64 }, (_, i) => ({ id: i + 1, name: 'test', link: 'https://example.test', tag: 'blog' }));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function wireCache(t) {
    const memory = new MemoryCache();
    const client = new EventEmitter();
    let disconnects = 0;
    client.isOpen = true;
    client.connect = async () => {};
    client.disconnect = async () => { disconnects++; client.isOpen = false; };
    client.ping = async () => 'PONG';
    client.lPop = key => memory.popBatch(key);
    client.set = (key, token, options) => memory.acquireLock(key, token, options.PX);
    client.eval = async (script, { keys, arguments: args }) => {
        if (keys.length === 2) return memory.publishBatches(keys[0], keys[1], args[0], args.slice(2), Number(args[1]));
        const owned = memory.locks.get(keys[0])?.token === args[0];
        await memory.releaseLock(keys[0], args[0]);
        return owned ? 1 : 0;
    };
    const cache = createRedisCache({ host: '127.0.0.1', port: 6379, timeoutMs: 20 }, logger, () => client);
    t.after(() => cache.close());
    return { cache, memory, client, disconnects: () => disconnects };
}

test('R2: a lock acquired before a missing acknowledgement is released by the failure finally', async t => {
    const { cache, memory, client } = wireCache(t);
    const ack = deferred();
    client.set = async (key, token, options) => {
        await memory.acquireLock(key, token, options.PX);
        return ack.promise;
    };
    let queries = 0;
    const source = createPrefetchSource({ cache, metrics: new RandomMetrics(), prefetchCandidates: async () => { queries++; return sites(); } });
    await assert.rejects(source.findCandidates(), error => error.outcomeUnknown === true && error.operation === 'acquireLock');
    assert.equal(memory.locks.size, 0);
    assert.equal(queries, 0);
    ack.resolve('OK');
    await tick();
    assert.equal(memory.locks.size, 0);
});

test('R2: a SET applied after failure cleanup gets a second token-checked cleanup on late success', async t => {
    const { cache, memory, client } = wireCache(t);
    const ack = deferred();
    let delayedSet;
    client.set = (key, token, options) => { delayedSet = { key, token, options }; return ack.promise; };
    const source = createPrefetchSource({ cache, metrics: new RandomMetrics(), prefetchCandidates: async () => { throw Error('must not query'); } });
    await assert.rejects(source.findCandidates(), /Redis operation timed out/);
    await memory.acquireLock(delayedSet.key, delayedSet.token, delayedSet.options.PX);
    assert.equal(memory.locks.size, 1);
    ack.resolve('OK');
    await tick();
    assert.equal(memory.locks.size, 0);
});

test('R2: a delayed SET with a permanently lost acknowledgement still needs its PX lease', async t => {
    const { cache, memory, client } = wireCache(t);
    let delayedSet;
    client.set = (key, token, options) => { delayedSet = { key, token, options }; return new Promise(() => {}); };
    const source = createPrefetchSource({ cache, metrics: new RandomMetrics(), lockMs: 100,
        prefetchCandidates: async () => { throw Error('must not query'); } });
    await assert.rejects(source.findCandidates(), /Redis operation timed out/);
    await memory.acquireLock(delayedSet.key, delayedSet.token, delayedSet.options.PX);
    assert.equal(await memory.acquireLock(delayedSet.key, 'new-owner', 100), null);
    memory.now = 101;
    assert.equal(await memory.acquireLock(delayedSet.key, 'new-owner', 100), 'OK');
    assert.equal(delayedSet.options.NX, true);
    assert.equal(delayedSet.options.PX, 100);
});

test('R2: late acknowledgement cleanup never deletes a newer owner\'s lease', async t => {
    const { cache, memory, client } = wireCache(t);
    const ack = deferred();
    let key;
    client.set = async (lockKey, token, options) => {
        key = lockKey; await memory.acquireLock(key, token, options.PX); return ack.promise;
    };
    const source = createPrefetchSource({ cache, metrics: new RandomMetrics(), prefetchCandidates: async () => { throw Error('must not query'); } });
    await assert.rejects(source.findCandidates(), /Redis operation timed out/);
    await memory.acquireLock(key, 'new-owner', 1000);
    ack.resolve('OK');
    await tick();
    assert.equal(memory.locks.get(key).token, 'new-owner');
});

test('R3: an applied LPOP with a delayed reply loses its batch without retry, reinsertion, or SQL', async t => {
    const { cache, memory, client } = wireCache(t);
    const ack = deferred();
    memory.pools.set(cacheKey(), { batches: [JSON.stringify([sites()[0]]), JSON.stringify([sites()[1]])], expires: 1000 });
    let pops = 0, queries = 0;
    client.lPop = async key => {
        const value = await memory.popBatch(key);
        if (++pops === 1) { await ack.promise; }
        return value;
    };
    const source = createPrefetchSource({ cache, metrics: new RandomMetrics(), prefetchCandidates: async () => { queries++; return sites(); } });
    await assert.rejects(source.findCandidates(), error => error.operation === 'popBatch' && error.outcomeUnknown === true);
    assert.equal(pops, 1);
    assert.equal(queries, 0);
    ack.resolve();
    await tick();
    assert.equal((await source.findCandidates())[0].id, 2);
    assert.equal(queries, 0);
});

test('R3: an applied publish with a lost reply is consumed later without repeating SQL or publishing', async t => {
    const { cache, memory, client } = wireCache(t);
    const ack = deferred();
    const evaluate = client.eval;
    let publishes = 0, queries = 0;
    client.eval = async (script, options) => {
        const result = await evaluate(script, options);
        if (options.keys.length === 2) { publishes++; await ack.promise; }
        return result;
    };
    const metrics = new RandomMetrics();
    const source = createPrefetchSource({ cache, metrics, prefetchCandidates: async () => { queries++; return sites(); } });
    await assert.rejects(source.findCandidates(), error => error.operation === 'publishBatches' && error.outcomeUnknown === true);
    assert.equal(memory.locks.size, 0);
    assert.equal((await source.findCandidates())[0].id, 9);
    ack.resolve();
    await tick();
    assert.equal(publishes, 1);
    assert.equal(queries, 1);
    assert.equal(metrics.snapshot().random_cache_refills_total, 0); // No success acknowledgement.
});

test('R4: a follower has its own deadline and does not cancel the owner or start duplicate SQL', { timeout: 2000 }, async () => {
    const entered = deferred(), sql = deferred();
    let queries = 0;
    const source = createPrefetchSource({ cache: new MemoryCache(), metrics: new RandomMetrics(), waitMs: 30,
        prefetchCandidates: async () => { queries++; entered.resolve(); return sql.promise; } });
    const owner = source.findCandidates();
    await entered.promise;
    try {
        await assert.rejects(source.findCandidates(), /refill timed out/);
        assert.equal(queries, 1);
    } finally { sql.resolve(sites()); }
    assert.equal((await owner).length, 8);
    await source.close();
});

test('R4: losing a batch after awaiting a refill cannot reset the original wait budget', async () => {
    const context = new AsyncLocalStorage();
    const cache = new MemoryCache();
    const pop = cache.popBatch.bind(cache);
    let clock = 0, waiterPops = 0, queries = 0;
    cache.popBatch = async key => {
        if (context.getStore() === 'waiter' && ++waiterPops === 2) {
            clock = 51; // Another caller consumed the batch after our original 50ms budget.
            return null;
        }
        return pop(key);
    };
    const entered = deferred(), sql = deferred();
    const source = createPrefetchSource({ cache, metrics: new RandomMetrics(), waitMs: 50, now: () => clock,
        prefetchCandidates: async () => { queries++; entered.resolve(); return sql.promise; } });
    const owner = source.findCandidates();
    await entered.promise;
    const waiter = context.run('waiter', () => source.findCandidates());
    const outcome = assert.rejects(waiter, /refill timed out/);
    await tick();
    sql.resolve(sites());
    await owner;
    await outcome;
    assert.equal(queries, 1);
    assert.equal(waiterPops, 2);
    await source.close();
});

test('R6: Redis close waits for an already-started late unlock cleanup and is idempotent', async t => {
    const { cache, client, disconnects } = wireCache(t);
    const ack = deferred(), cleanup = deferred(), entered = deferred();
    client.set = () => ack.promise;
    client.eval = () => { entered.resolve(); return cleanup.promise; };
    await assert.rejects(cache.acquireLock('test-lock', 'token', 1000), /Redis operation timed out/);
    ack.resolve('OK');
    await entered.promise;
    const closing = cache.close();
    assert.equal(cache.close(), closing);
    assert.equal(disconnects(), 0);
    cleanup.resolve(1);
    await closing;
    assert.equal(disconnects(), 1);
});

test('R6: disconnecting an HTTP client cannot bypass shutdown drain of SQL, publish, and unlock', { timeout: 3000 }, async () => {
    const sql = deferred(), sqlEntered = deferred();
    const publish = deferred(), publishEntered = deferred();
    const release = deferred(), releaseEntered = deferred();
    const cache = new MemoryCache();
    const events = [];
    const publishBatches = cache.publishBatches.bind(cache);
    const releaseLock = cache.releaseLock.bind(cache);
    cache.publishBatches = async (...args) => {
        publishEntered.resolve(); await publish.promise;
        const result = await publishBatches(...args); events.push('published'); return result;
    };
    cache.releaseLock = async (...args) => {
        releaseEntered.resolve(); await release.promise;
        await releaseLock(...args); events.push('unlocked');
    };
    cache.close = async () => { cache.closed++; events.push('redis-closed'); };
    let dbClosed = 0;
    const runtime = await start({ config: { host: '127.0.0.1', port: 0, database: { clientQueryTimeoutMs: 100 }, redis: { timeoutMs: 100 }, cacheTtlSeconds: 30 }, logger,
        createDatabase: () => ({ kind: 'mock', check: async () => {},
            prefetchCandidates: async () => { sqlEntered.resolve(); return sql.promise; },
            close: async () => { dbClosed++; events.push('mysql-closed'); } }),
        createCache: () => cache,
    });
    const request = http.get({ host: '127.0.0.1', port: runtime.server.address().port, path: '/random', agent: false });
    request.on('error', () => {});
    let closing;
    try {
        await sqlEntered.promise;
        request.destroy();
        closing = runtime.close();
        let done = false;
        closing.then(() => { done = true; });
        await tick();
        assert.equal(done, false);
        assert.equal(cache.closed, 0);
        assert.equal(dbClosed, 0);
        sql.resolve(sites());
        await publishEntered.promise;
        assert.equal(done, false);
        publish.resolve();
        await releaseEntered.promise;
        assert.equal(cache.closed, 0);
        assert.equal(dbClosed, 0);
        release.resolve();
        await closing;
        assert.ok(events.indexOf('unlocked') < events.indexOf('redis-closed'));
        assert.ok(events.indexOf('unlocked') < events.indexOf('mysql-closed'));
        assert.equal(cache.closed, 1);
        assert.equal(dbClosed, 1);
    } finally {
        request.destroy(); sql.resolve(sites()); publish.resolve(); release.resolve();
        await (closing || runtime.close());
    }
});

test('R6: a draining source rejects new requests while allowing its admitted owner to finish', async () => {
    const entered = deferred(), sql = deferred();
    let queries = 0;
    const source = createPrefetchSource({ cache: new MemoryCache(), metrics: new RandomMetrics(),
        prefetchCandidates: async () => { queries++; entered.resolve(); return sql.promise; } });
    const owner = source.findCandidates();
    await entered.promise;
    const closing = source.close();
    assert.equal(source.close(), closing);
    await assert.rejects(source.findCandidates(), error => error.code === 'RANDOM_PREFETCH_CLOSING');
    sql.resolve(sites());
    await owner;
    await closing;
    assert.equal(queries, 1);
});

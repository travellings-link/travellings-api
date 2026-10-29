const test = require('node:test');
const assert = require('node:assert/strict');
const { createResampleSource } = require('../../modules/random/resample');
const { RandomMetrics } = require('../../modules/random/metrics');
const { readConfig } = require('../../mvp/random/config');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const budgetError = error => error.code === 'RANDOM_RESAMPLE_BUDGET';
const closingError = error => error.code === 'RANDOM_RESAMPLE_CLOSING';

test('supplemental samples retain their request scope and use separate SQL metrics', async () => {
    const metrics = new RandomMetrics();
    const calls = [];
    const source = createResampleSource({ metrics, now: () => 0, resampleCandidates: async query => {
        calls.push(query); return [{ id: 42 }];
    } });
    const query = { tag: 'life' };
    assert.deepEqual(await source.findCandidates(query), [{ id: 42 }]);
    assert.deepEqual(calls, [{ tag: 'life' }]);
    const stats = metrics.snapshot();
    assert.equal(stats.random_resample_queries_total, 1);
    assert.equal(stats.random_query_duration_seconds.count, 1);
    assert.equal(stats.random_resample_query_duration_seconds.count, 1);
    assert.equal(stats.random_prefetch_query_duration_seconds.count, 0);
    await source.close();
});

test('concurrency refusal dispatches no SQL and preserves the remaining rate token', async () => {
    const metrics = new RandomMetrics();
    const gate = deferred();
    let queries = 0;
    const source = createResampleSource({ metrics, now: () => 0, resampleCandidates: async () => {
        if (++queries === 1) return gate.promise;
        return [{ id: queries }];
    } });
    const first = source.findCandidates({ tag: 'life' });
    await assert.rejects(source.findCandidates({ tag: 'life' }), budgetError);
    assert.equal(queries, 1);
    gate.resolve([{ id: 5 }]);
    assert.deepEqual(await first, [{ id: 5 }]);
    assert.deepEqual(await source.findCandidates({ tag: 'life' }), [{ id: 2 }]);
    await assert.rejects(source.findCandidates({ tag: 'life' }), budgetError);
    assert.equal(queries, 2);
    assert.equal(metrics.snapshot().random_resample_rejected_total, 2);
    assert.equal(metrics.snapshot().random_resample_queries_total, 2);
    await source.close();
});

test('the deterministic rate budget refills gradually and never exceeds its burst cap', async () => {
    const metrics = new RandomMetrics();
    let timestamp = 0, queries = 0;
    const source = createResampleSource({ metrics, now: () => timestamp,
        resampleCandidates: async () => { queries++; return []; } });
    await source.findCandidates({ tag: 'life' });
    await source.findCandidates({ tag: 'life' });
    await assert.rejects(source.findCandidates({ tag: 'life' }), budgetError);
    timestamp = 499;
    await assert.rejects(source.findCandidates({ tag: 'life' }), budgetError);
    timestamp = 500;
    await source.findCandidates({ tag: 'life' });
    await assert.rejects(source.findCandidates({ tag: 'life' }), budgetError);
    timestamp = 100000;
    await source.findCandidates({ tag: 'life' });
    await source.findCandidates({ tag: 'life' });
    await assert.rejects(source.findCandidates({ tag: 'life' }), budgetError);
    assert.equal(queries, 5);
    assert.equal(metrics.snapshot().random_resample_rejected_total, 4);
    await source.close();
});

test('both async failure and synchronous throw release their slot but do not refund rate tokens', async () => {
    const metrics = new RandomMetrics();
    let timestamp = 0, queries = 0;
    const source = createResampleSource({ metrics, now: () => timestamp, resampleCandidates: () => {
        queries++;
        if (queries === 1) return Promise.reject(Error('network failure'));
        if (queries === 2) throw Error('synchronous adapter failure');
        return Promise.resolve([{ id: 7 }]);
    } });
    await assert.rejects(source.findCandidates({ tag: 'life' }), /network failure/);
    await assert.rejects(source.findCandidates({ tag: 'life' }), /synchronous adapter failure/);
    await assert.rejects(source.findCandidates({ tag: 'life' }), budgetError);
    assert.equal(queries, 2);
    timestamp = 500;
    assert.deepEqual(await source.findCandidates({ tag: 'life' }), [{ id: 7 }]);
    const stats = metrics.snapshot();
    assert.equal(stats.random_resample_queries_total, 3);
    assert.equal(stats.random_resample_errors_total, 2);
    assert.equal(stats.random_resample_query_duration_seconds.count, 3);
    await source.close();
});

test('close is idempotent, refuses new work, and waits for an admitted query to settle', async () => {
    const metrics = new RandomMetrics();
    const gate = deferred();
    let queries = 0;
    const source = createResampleSource({ metrics, resampleCandidates: () => { queries++; return gate.promise; } });
    const work = source.findCandidates({ tag: 'life' });
    const outcome = work.then(value => ({ value }), error => ({ error }));
    const closing = source.close();
    assert.equal(source.close(), closing);
    let closed = false;
    closing.then(() => { closed = true; });
    await assert.rejects(source.findCandidates({ tag: 'life' }), closingError);
    await Promise.resolve();
    assert.equal(closed, false);
    assert.equal(queries, 1);
    gate.reject(Error('admitted query failed during shutdown'));
    assert.match((await outcome).error.message, /during shutdown/);
    await closing;
    assert.equal(closed, true);
    assert.equal(metrics.snapshot().random_resample_errors_total, 1);
    assert.equal(metrics.snapshot().random_resample_rejected_total, 0);
});

test('invalid supplemental samples fail without retry, release their slot, and count as query errors', async () => {
    for (const invalid of [null, {}, Array(1), Array.from({ length: 65 }, (_, i) => ({ id: i + 1 })), [{ id: '7' }], [{ id: 0 }], [{ id: 1 }, { id: 1 }]]) {
        const metrics = new RandomMetrics();
        let queries = 0;
        const source = createResampleSource({ metrics, now: () => 0, resampleCandidates: async () => {
            return ++queries === 1 ? invalid : [{ id: 7 }];
        } });
        await assert.rejects(source.findCandidates({ tag: 'life' }), /Invalid.*result|Expected at most/);
        assert.equal(queries, 1);
        assert.equal(metrics.snapshot().random_resample_errors_total, 1);
        assert.deepEqual(await source.findCandidates({ tag: 'life' }), [{ id: 7 }]);
        assert.equal(metrics.snapshot().random_resample_query_duration_seconds.count, 2);
        await source.close();
    }
});

test('draining admission refuses work without spending the query budget', async () => {
    let draining = true, queries = 0;
    const metrics = new RandomMetrics();
    const source = createResampleSource({ metrics, now: () => 0, burst: 1,
        isDraining: () => draining, resampleCandidates: async () => { queries++; return []; } });
    await assert.rejects(source.findCandidates({ tag: 'life' }), closingError);
    draining = false;
    await source.findCandidates({ tag: 'life' });
    source.stopAccepting();
    await assert.rejects(source.findCandidates({ tag: 'life' }), closingError);
    assert.equal(queries, 1);
    assert.equal(metrics.snapshot().random_resample_rejected_total, 0);
    await source.close();
});

test('concurrent requests keep independent supplemental samples and preserve tag scope', async () => {
    const metrics = new RandomMetrics();
    const gates = [deferred(), deferred()];
    const calls = [];
    const source = createResampleSource({ metrics, maxInFlight: 2, now: () => 0, resampleCandidates: query => {
        calls.push(query); return gates[calls.length - 1].promise;
    } });
    const first = source.findCandidates({ tag: 'life' });
    const second = source.findCandidates({ tag: 'blog' });
    gates[0].resolve([{ id: 2 }]);
    gates[1].resolve([{ id: 1 }]);
    assert.deepEqual(await Promise.all([first, second]), [[{ id: 2 }], [{ id: 1 }]]);
    assert.deepEqual(calls, [{ tag: 'life' }, { tag: 'blog' }]);
    assert.equal(metrics.snapshot().random_resample_queries_total, 2);
    await source.close();
});

test('resampling budgets reject invalid values and environment configuration remains bounded', () => {
    const base = { metrics: new RandomMetrics(), resampleCandidates: async () => [] };
    assert.throws(() => createResampleSource({ ...base, resampleCandidates: undefined }), /required/);
    for (const key of ['maxInFlight', 'ratePerSecond', 'burst']) {
        for (const value of [0, -1, 0.5, NaN, Infinity, '1', null]) {
            assert.throws(() => createResampleSource({ ...base, [key]: value }), /Invalid .*budget/);
        }
    }
    const env = { RANDOM_MVP_DB_NAME: 'test', RANDOM_MVP_DB_USER: 'readonly' };
    assert.deepEqual(readConfig(env).resample, { maxInFlight: 1, ratePerSecond: 2, burst: 2 });
    for (const [key, value] of [
        ['RANDOM_MVP_RESAMPLE_MAX_IN_FLIGHT', '0'], ['RANDOM_MVP_RESAMPLE_MAX_IN_FLIGHT', '5'],
        ['RANDOM_MVP_RESAMPLE_RATE_PER_SECOND', '0'], ['RANDOM_MVP_RESAMPLE_RATE_PER_SECOND', '1001'],
        ['RANDOM_MVP_RESAMPLE_BURST', '0'], ['RANDOM_MVP_RESAMPLE_BURST', '1001'],
    ]) assert.throws(() => readConfig({ ...env, [key]: value }));
});

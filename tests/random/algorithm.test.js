const test = require('node:test');
const assert = require('node:assert/strict');
const { BloomFilter } = require('../../modules/random/bloom');
const { emptyHistory, loadHistory, serializeHistory, HISTORY_TTL_SECONDS } = require('../../modules/random/history');
const { selectCandidate } = require('../../modules/random/select');
const { RandomMetrics } = require('../../modules/random/metrics');

const NOW = 1801094400;
const sites = (...ids) => ids.map(id => ({ id }));
function visited(...ids) {
    const history = emptyHistory();
    for (const id of ids) history.bloom.add(id);
    history.n = ids.length;
    history.lastId = ids.at(-1) ?? null;
    return history;
}

test('Bloom round-trip preserves recorded IDs and rejects malformed encodings', () => {
    const bloom = new BloomFilter();
    for (let id = 1; id <= 15; id++) bloom.add(id);
    const restored = BloomFilter.fromBase64(bloom.toBase64());
    for (let id = 1; id <= 15; id++) assert.equal(restored.has(id), true);
    for (const raw of ['', 'bad', Buffer.alloc(41).toString('base64'), `${bloom.toBase64()}!`]) {
        assert.throws(() => BloomFilter.fromBase64(raw));
    }
});

test('expired, missing, and damaged cookies discard the entire state including lastId', () => {
    const good = JSON.parse(serializeHistory(visited(1), NOW));
    const cases = [undefined, null, 'not json', JSON.stringify(null), JSON.stringify([]), 'x'.repeat(513),
        { ...good, t: NOW - HISTORY_TTL_SECONDS }, { ...good, t: NOW + 1 },
        { ...good, t: 'yesterday' }, { ...good, n: -1 }, { ...good, n: 16 },
        { ...good, n: 1.5 }, { ...good, lastId: '1' }, { ...good, bf: 'damaged' }, { ...good, v: 2 }];
    for (const input of cases) {
        const raw = typeof input === 'object' && input !== null ? JSON.stringify(input) : input;
        const history = loadHistory(raw, NOW);
        assert.equal(history.n, 0);
        assert.equal(history.lastId, null);
        assert.equal(selectCandidate(sites(1, 2), history).site.id, 1);
    }
    assert.equal(loadHistory(JSON.stringify({ ...good, t: NOW - HISTORY_TTL_SECONDS + 1 }), NOW).lastId, 1);
});

test('the fifteenth success remains recorded; the next request rotates and retains lastId', () => {
    const history = visited(...Array.from({ length: 14 }, (_, i) => i + 1));
    assert.equal(selectCandidate(sites(15), history).site.id, 15);
    assert.equal(history.n, 15);
    assert.equal(history.bloom.has(1), true);
    const next = selectCandidate(sites(15, 16), history);
    assert.equal(next.site.id, 16);
    assert.equal(next.fallback, false);
    assert.equal(next.bloomHits, 0);
    assert.equal(history.n, 1);
    assert.equal(history.lastId, 16);
    assert.equal(history.bloom.has(16), true);
    assert.equal(history.bloom.has(1), false);
});

test('same-batch fallback resets the count to one and immediately records its result', () => {
    const history = visited(1, 2);
    const result = selectCandidate(sites(2, 1), history);
    assert.equal(result.site.id, 1);
    assert.equal(result.bloomHits, 2);
    assert.equal(result.fallback, true);
    assert.equal(history.n, 1);
    assert.equal(history.lastId, 1);
    assert.equal(history.bloom.has(1), true);
    assert.equal(history.bloom.has(2), false);
});

test('lastId rejection alone is not a Bloom hit; a one-site pool can repeat', () => {
    const history = emptyHistory();
    history.lastId = 7;
    const result = selectCandidate(sites(7), history);
    assert.equal(result.bloomHits, 0);
    assert.equal(result.fallback, true);
    assert.equal(history.n, 1);
    assert.equal(history.bloom.has(7), true);
});

test('an empty batch is not fallback; Bloom hits count only inspected candidates', () => {
    const history = visited(1, 2);
    assert.deepEqual(selectCandidate([], history), { site: null, bloomHits: 0, fallback: false });
    assert.equal(history.n, 2);
    const result = selectCandidate(sites(1, 3, 2), history);
    assert.equal(result.site.id, 3);
    assert.equal(result.bloomHits, 1);
    assert.throws(() => selectCandidate(sites(1, 2, 3, 4, 5, 6, 7, 8, 9), history));
});

test('saturated history falls back within the batch and immediately becomes usable', () => {
    const history = { bloom: new BloomFilter(Buffer.alloc(40, 255)), n: 1, lastId: 2 };
    assert.equal(selectCandidate(sites(2, 3), history).site.id, 3);
    assert.equal(history.n, 1);
    assert.equal(selectCandidate(sites(3, 4), history).site.id, 4);
});

test('three-site pools start new rounds without consecutive repeats', () => {
    const history = emptyHistory();
    const ids = [];
    for (let i = 0; i < 30; i++) ids.push(selectCandidate(sites(1, 2, 3), history).site.id);
    assert.equal(new Set(ids).size, 3);
    assert.ok(ids.every((id, i) => i === 0 || id !== ids[i - 1]));
});

test('fresh random batches remain selectable after multiple history rotations', () => {
    const history = emptyHistory();
    const ids = [];
    for (let id = 1; id <= 100; id++) {
        ids.push(selectCandidate(sites(id, id + 100), history).site.id);
    }
    assert.ok(new Set(ids).size > 15);
});

test('metrics expose cumulative second-based buckets and immutable snapshots', () => {
    const metrics = new RandomMetrics();
    metrics.increment('random_requests_total');
    metrics.observeQuery(0.02);
    metrics.observeQuery(0.2);
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.random_query_duration_seconds.count, 2);
    assert.equal(snapshot.random_query_duration_seconds.buckets.find(b => b.le === 0.025).count, 1);
    assert.equal(snapshot.random_query_duration_seconds.buckets.find(b => b.le === 0.25).count, 2);
    snapshot.random_query_duration_seconds.buckets[0].count = 100;
    assert.equal(metrics.snapshot().random_query_duration_seconds.buckets[0].count, 0);
    assert.match(metrics.toPrometheus(), /random_query_duration_seconds_bucket\{le="\+Inf"\} 2/);
    assert.match(metrics.toPrometheus(), /random_query_duration_seconds_count 2/);
    assert.throws(() => metrics.increment('unbounded_metric'));
});

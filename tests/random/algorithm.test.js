const test = require('node:test');
const assert = require('node:assert/strict');
const { BloomFilter } = require('../../modules/random/bloom');
const { emptyHistory, loadHistory, serializeHistory, appendHistory, relaxHistory, HISTORY_LIMIT, HISTORY_TTL_SECONDS } = require('../../modules/random/history');
const { selectCandidate, selectRelaxedCandidate } = require('../../modules/random/select');
const { RandomMetrics } = require('../../modules/random/metrics');

const NOW = 1801094400;
const sites = (...ids) => ids.map(id => ({ id }));
function visited(...ids) {
    const history = emptyHistory();
    ids.forEach(id => appendHistory(history, id));
    return history;
}
const has = (history, id) => history.current.has(id) || history.previous.has(id);

test('rolling history serializes two Bloom generations without exact IDs or fingerprints', () => {
    const history = visited(7, 1, 2147483647);
    const raw = serializeHistory(history, NOW);
    const state = JSON.parse(raw);
    assert.deepEqual(Object.keys(state).sort(), ['bf', 'lastId', 'n', 'prev', 't', 'v']);
    assert.equal(state.v, 3);
    assert.equal(state.n, 3);
    assert.equal(state.lastId, 2147483647);
    assert.equal(Buffer.from(state.bf, 'base64').length, 40);
    assert.equal(Buffer.from(state.prev, 'base64').length, 40);
    const restored = loadHistory(raw, NOW);
    for (const id of [7, 1, 2147483647]) assert.equal(has(restored, id), true);
    restored.current.bytes.fill(0);
    assert.equal(history.current.has(7), true);
    assert.equal(HISTORY_LIMIT, 20);
});

test('expired, corrupt, incompatible and inconsistent cookies reset both generations and lastId', () => {
    const good = JSON.parse(serializeHistory(visited(1), NOW));
    const empty = new BloomFilter().toBase64();
    const cases = [undefined, null, 'not json', JSON.stringify(null), JSON.stringify([]), 'x'.repeat(1025),
        { ...good, t: NOW - HISTORY_TTL_SECONDS }, { ...good, t: NOW + 1 },
        { ...good, t: 'yesterday' }, { ...good, t: -1 }, { ...good, t: NOW + 0.5 },
        { ...good, n: -1 }, { ...good, n: 20 }, { ...good, n: 0.5 },
        { ...good, lastId: 0 }, { ...good, lastId: '1' }, { ...good, lastId: 2147483648 },
        { ...good, bf: 'broken' }, { ...good, prev: 'broken' }, { ...good, bf: empty },
        { ...good, n: 0 }, { ...good, v: 1 }, { v: 2, ids: [1], t: NOW }];
    for (const input of cases) {
        const raw = typeof input === 'object' && input !== null ? JSON.stringify(input) : input;
        const history = loadHistory(raw, NOW);
        assert.deepEqual(history, emptyHistory());
        assert.equal(selectCandidate(sites(1, 2), history).site.id, 1);
    }
    assert.equal(loadHistory(JSON.stringify({ ...good, t: NOW - HISTORY_TTL_SECONDS + 1 }), NOW).lastId, 1);
});

test('twentieth success immediately rotates the complete current generation while retaining recent visits', () => {
    const history = visited(...Array.from({ length: 19 }, (_, i) => i + 1));
    assert.equal(history.n, 19);
    appendHistory(history, 20);
    assert.equal(history.n, 0);
    assert.equal(history.lastId, 20);
    assert.ok(history.current.bytes.every(byte => byte === 0));
    for (let id = 1; id <= 20; id++) assert.equal(history.previous.has(id), true);
    const restored = loadHistory(serializeHistory(history, NOW), NOW);
    assert.equal(restored.n, 0);
    assert.equal(restored.lastId, 20);
    appendHistory(restored, 21);
    assert.equal(restored.current.has(21), true);
    for (let id = 2; id <= 21; id++) assert.equal(has(restored, id), true);
});

test('the second rotation drops the older generation and retains precisely the last completed block', () => {
    const history = visited(...Array.from({ length: 39 }, (_, i) => i + 1));
    assert.equal(history.n, 19);
    assert.equal(history.previous.has(1), true);
    assert.equal(history.current.has(39), true);
    const retiringGeneration = history.previous;
    const completedGeneration = history.current;
    appendHistory(history, 40);
    assert.equal(history.previous, completedGeneration);
    assert.notEqual(history.previous, retiringGeneration);
    assert.equal(history.n, 0);
    for (let id = 21; id <= 40; id++) assert.equal(history.previous.has(id), true);
    assert.ok(history.current.bytes.every(byte => byte === 0));
});

test('both generations and lastId are filtered without mutation or premature rotation', () => {
    const history = visited(...Array.from({ length: 21 }, (_, i) => i + 1));
    const before = serializeHistory(history, NOW);
    assert.deepEqual(selectCandidate(sites(1, 21, 10000), history), { site: { id: 10000 }, bloomHits: 2 });
    assert.deepEqual(selectCandidate(sites(1, 21), history), { site: null, bloomHits: 2 });
    assert.deepEqual(selectCandidate([], history), { site: null, bloomHits: 0 });
    assert.equal(serializeHistory(history, NOW), before);
    assert.throws(() => selectCandidate(sites(1, 2, 3, 4, 5, 6, 7, 8, 9), history));
    assert.throws(() => selectCandidate(sites(1, 1), history));
    const independentLastId = emptyHistory();
    independentLastId.lastId = 7;
    assert.deepEqual(selectCandidate(sites(7, 8), independentLastId), { site: { id: 8 }, bloomHits: 0 });
});

test('a saturated Bloom rejects candidates without clearing either generation or advancing success count', () => {
    const history = visited(1);
    history.current.bytes.fill(255);
    const before = serializeHistory(history, NOW);
    assert.deepEqual(selectCandidate(sites(1, 2, 3), history), { site: null, bloomHits: 3 });
    assert.equal(serializeHistory(history, NOW), before);
});

test('relaxed selection releases only the previous generation when the current generation permits a non-last candidate', () => {
    const history = visited(...Array.from({ length: 21 }, (_, i) => i + 1));
    const before = serializeHistory(history, NOW);
    const selected = selectRelaxedCandidate(sites(21, 2, 1), history);
    assert.deepEqual(selected, { site: { id: 2 }, relaxation: 'previous' });
    assert.equal(serializeHistory(history, NOW), before);
    const current = history.current;
    relaxHistory(history, selected.relaxation);
    assert.equal(history.current, current);
    assert.equal(history.n, 1);
    assert.equal(history.lastId, 21);
    assert.ok(history.previous.bytes.every(byte => byte === 0));
    appendHistory(history, selected.site.id);
    assert.equal(history.n, 2);
    assert.equal(history.current.has(21), true);
    assert.equal(history.current.has(2), true);
    assert.equal(loadHistory(serializeHistory(history, NOW), NOW).lastId, 2);
});

test('relaxed selection resets both generations only when necessary and immediately records the selected result', () => {
    const history = visited(1, 2);
    const before = serializeHistory(history, NOW);
    const selected = selectRelaxedCandidate(sites(2, 1), history);
    assert.deepEqual(selected, { site: { id: 1 }, relaxation: 'all' });
    assert.equal(serializeHistory(history, NOW), before);
    relaxHistory(history, selected.relaxation);
    assert.equal(history.n, 0);
    assert.equal(history.lastId, 2);
    assert.ok(history.current.bytes.every(byte => byte === 0));
    assert.ok(history.previous.bytes.every(byte => byte === 0));
    appendHistory(history, selected.site.id);
    assert.equal(history.n, 1);
    assert.equal(history.lastId, 1);
    assert.equal(history.current.has(1), true);
    assert.equal(loadHistory(serializeHistory(history, NOW), NOW).current.has(1), true);
    assert.deepEqual(selectRelaxedCandidate(sites(1), history), { site: { id: 1 }, relaxation: 'all' });
});

test('rolling generations cover the previous twenty successful visits over repeated cookie round-trips', () => {
    let history = emptyHistory();
    const visits = [];
    for (let index = 0; index < 120; index++) {
        const candidates = sites(...Array.from({ length: 8 }, (_, offset) => index * 8 + offset + 1));
        const { site } = selectCandidate(candidates, history);
        assert.ok(site);
        assert.ok(!visits.slice(-20).includes(site.id));
        visits.push(site.id);
        appendHistory(history, site.id);
        history = loadHistory(serializeHistory(history, NOW), NOW);
        for (const recent of visits.slice(-20)) assert.equal(has(history, recent), true);
        assert.ok(history.n >= 0 && history.n < 20);
    }
});

test('metrics separate query sources and unresolved resampling from actual errors', () => {
    const metrics = new RandomMetrics();
    metrics.increment('random_requests_total');
    metrics.increment('random_bloom_hits_total', 2);
    metrics.increment('random_resample_unresolved_total');
    metrics.observeQuery(0.02, 'prefetch');
    metrics.observeQuery(0.2, 'resample');
    metrics.observeRequest(0.3);
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.random_query_duration_seconds.count, 2);
    assert.equal(snapshot.random_prefetch_query_duration_seconds.count, 1);
    assert.equal(snapshot.random_resample_query_duration_seconds.count, 1);
    assert.equal(snapshot.random_request_duration_seconds.count, 1);
    assert.equal(snapshot.random_bloom_hits_total, 2);
    assert.equal(snapshot.random_resample_unresolved_total, 1);
    assert.equal(snapshot.random_errors_total, 0);
    snapshot.random_query_duration_seconds.buckets[0].count = 100;
    assert.equal(metrics.snapshot().random_query_duration_seconds.buckets[0].count, 0);
    assert.match(metrics.toPrometheus(), /random_query_duration_seconds_bucket\{le="\+Inf"\} 2/);
    assert.match(metrics.toPrometheus(), /random_resample_query_duration_seconds_count 1/);
    assert.ok(!Object.hasOwn(snapshot, 'random_history_hits_total'));
    assert.ok(!Object.hasOwn(snapshot, 'random_history_exhausted_total'));
    assert.throws(() => metrics.increment('unbounded_metric'));
});

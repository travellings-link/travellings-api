const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMvpApp } = require('../../mvp/random/app');
const { createPrefetchSource } = require('../../modules/random/prefetch');
const { RandomMetrics } = require('../../modules/random/metrics');
const { MemoryCache } = require('./memoryCache');
const { runBenchmark } = require('../../scripts/random-mvp-benchmark');

function seededRandom(seed) {
    return () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
}

test('88 Life sites, twenty independent cookie users, fifty serial visits each: no recent-twenty repeats', { timeout: 15000 }, async t => {
    // Real HTTP, Cookie parsing/serialization and prefetch orchestration; storage and SQL are simulated.
    const random = seededRandom(0x20261029);
    const sites = Array.from({ length: 88 }, (_, index) => ({ id: index + 1, name: `Life ${index + 1}`, link: `https://life${index + 1}.example`, tag: 'life' }));
    function shuffled(rows) {
        const result = rows.slice();
        for (let index = result.length - 1; index > 0; index--) {
            const other = Math.floor(random() * (index + 1));
            [result[index], result[other]] = [result[other], result[index]];
        }
        return result;
    }
    let prefetchQueries = 0;
    let resampleQueries = 0;
    const database = {
        kind: 'mock',
        check: async () => {},
        resampleCandidates: async ({ tag }) => {
            assert.equal(tag, 'life');
            resampleQueries++;
            return shuffled(sites).slice(0, 64);
        },
    };
    const metrics = new RandomMetrics();
    const cache = new MemoryCache();
    const candidateSource = createPrefetchSource({ cache, metrics, prefetchCandidates: async ({ tag }) => {
        assert.equal(tag, 'life');
        prefetchQueries++;
        return shuffled(sites).slice(0, 64);
    } });
    const app = createMvpApp({ database, cache, candidateSource, metrics, maxInFlight: 8, logger: { error() {} } });
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(async () => { await new Promise(resolve => server.close(resolve)); await candidateSource.close(); });
    const report = await runBenchmark({ baseUrl: `http://127.0.0.1:${server.address().port}`, users: 20, visits: 50, concurrency: 8, tag: 'life' });
    assert.equal(report.requests_total, 1000);
    assert.equal(report.successful_requests, 1000);
    assert.equal(report.failed_checks, 0);
    assert.equal(report.recent_twenty_repeats, 0);
    assert.equal(report.query_duration_source, 'mock');
    assert.equal(prefetchQueries, 125);
    assert.equal(report.server_delta.prefetch_queries, prefetchQueries);
    assert.equal(report.server_delta.resample_queries, resampleQueries);
    assert.equal(report.server_delta.actual_candidate_queries, prefetchQueries + resampleQueries);
    assert.equal(report.server_delta.cache_hits + report.server_delta.cache_misses, 1000);
    assert.equal(report.server_delta.fallback_selections, 0);
    assert.equal(report.server_delta.history_relaxations, 0);
    assert.equal(report.server_delta.history_resets, 0);

    assert.ok(report.client_latency_ms.p99 >= report.client_latency_ms.p95);
    assert.ok(report.client_latency_ms.p95 >= report.client_latency_ms.p50);
    t.diagnostic(`Simulated storage only; not production MySQL/Redis performance. ${JSON.stringify(report)}`);
});

test('benchmark distinguishes independent cookie histories, repetitions, and HTTP-200 business failures', async t => {
    const server = http.createServer((req, res) => {
        if (req.url === '/stats') { res.writeHead(404); res.end(); return; }
        const previous = Number(/_tvl_mvp=(\d+)/.exec(req.headers.cookie || '')?.[1] || 0);
        const visit = previous + 1;
        res.setHeader('Set-Cookie', `_tvl_mvp=${visit}; Path=/random; HttpOnly`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(visit === 3 ? { success: false } : { success: true, data: [{ id: 1 }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const report = await runBenchmark({ baseUrl: `http://127.0.0.1:${server.address().port}`, users: 2, visits: 3, concurrency: 2 });
    assert.equal(report.requests_total, 6);
    assert.equal(report.successful_requests, 4);
    assert.equal(report.recent_twenty_repeats, 2);
    assert.equal(report.failed_checks, 2);
    assert.deepEqual(report.failure_reasons, { unsuccessful_result: 2 });
    assert.equal(report.server_delta.actual_candidate_queries, null);
    assert.equal(report.query_duration_source, null);
});

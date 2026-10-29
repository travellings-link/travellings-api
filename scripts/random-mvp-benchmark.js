const http = require('node:http');
const https = require('node:https');
const { performance } = require('node:perf_hooks');

function request(url, { cookie, timeoutMs }) {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.get(url, { agent: false, headers: cookie ? { Cookie: cookie } : {} }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
                body += chunk;
                if (body.length > 1024 * 1024) req.destroy(new Error('Response exceeds benchmark limit'));
            });
            res.on('aborted', () => reject(new Error('Response aborted')));
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        const timer = setTimeout(() => req.destroy(new Error('HTTP deadline exceeded')), timeoutMs);
        req.on('error', reject);
        req.once('close', () => clearTimeout(timer));
    });
}

function percentile(sorted, fraction) {
    return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : 0;
}

function integer(value, name, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
    return value;
}

async function runBenchmark({ baseUrl, tag = 'life', users = 20, visits = 50, concurrency = 8, timeoutMs = 10000 }) {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
        throw new TypeError('Supply an explicit HTTP(S) service base URL without credentials, query, or fragment');
    }
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    integer(users, 'users', 1, 1000);
    integer(visits, 'visits', 1, 100000);
    integer(concurrency, 'concurrency', 1, 64);
    integer(timeoutMs, 'timeoutMs', 1, 120000);
    if (typeof tag !== 'string' || tag.length > 255) throw new TypeError('tag must contain at most 255 characters');
    const randomUrl = new URL('random', base);
    if (tag) randomUrl.searchParams.set('tag', tag);
    const readStats = async () => {
        try {
            const response = await request(new URL('stats', base), { timeoutMs });
            if (response.status !== 200) return null;
            const stats = JSON.parse(response.body);
            return stats && typeof stats.metrics === 'object' ? stats : null;
        } catch { return null; }
    };
    const before = await readStats();
    const latencies = [];
    const failures = {};
    let successful = 0;
    let repeats = 0;
    let nextUser = 0;
    const fail = reason => { failures[reason] = (failures[reason] || 0) + 1; };
    const started = performance.now();
    async function worker() {
        for (;;) {
            const user = nextUser++;
            if (user >= users) return;
            const cookies = new Map();
            const history = [];
            for (let visit = 0; visit < visits; visit++) {
                const began = performance.now();
                try {
                    const response = await request(randomUrl, {
                        cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '), timeoutMs,
                    });
                    for (const raw of response.headers['set-cookie'] || []) {
                        const pair = raw.split(';', 1)[0];
                        const equals = pair.indexOf('=');
                        if (equals > 0) cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
                    }
                    if (response.status !== 200) { fail(`http_${response.status}`); continue; }
                    let body;
                    try { body = JSON.parse(response.body); } catch { fail('invalid_json'); continue; }
                    const id = body?.data?.[0]?.id;
                    if (body?.success !== true || !Number.isInteger(id) || id <= 0 || id > 2147483647) {
                        fail('unsuccessful_result'); continue;
                    }
                    successful++;
                    if (!response.headers['set-cookie']?.length) fail('missing_history_cookie');
                    if (history.includes(id)) repeats++;
                    history.push(id);
                    if (history.length > 20) history.shift();
                } catch { fail('transport_error'); }
                finally { latencies.push(performance.now() - began); }
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(users, concurrency) }, worker));
    const elapsedMs = performance.now() - started;
    const after = await readStats();
    const compatibleStats = before && after && before.started_at === after.started_at;
    const delta = (name, histogram = false) => {
        if (!compatibleStats) return null;
        const first = histogram ? before.metrics[name]?.count : before.metrics[name];
        const last = histogram ? after.metrics[name]?.count : after.metrics[name];
        return Number.isFinite(first) && Number.isFinite(last) && last >= first ? last - first : null;
    };
    const hits = delta('random_cache_hits_total');
    const misses = delta('random_cache_misses_total');
    latencies.sort((a, b) => a - b);
    return {
        scenario: { tag, users, visits_per_user: visits, max_concurrency: Math.min(users, concurrency), history_window: 20 },
        requests_total: users * visits,
        successful_requests: successful,
        failed_checks: Object.values(failures).reduce((sum, count) => sum + count, 0),
        failure_reasons: failures,
        recent_twenty_repeats: repeats,
        elapsed_ms: elapsedMs,
        requests_per_second: users * visits * 1000 / elapsedMs,
        client_latency_ms: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99), max: latencies.at(-1) || 0 },
        server_metrics_scope: compatibleStats ? 'Process-wide delta; isolate unrelated traffic for attribution.' : 'Unavailable or service restarted during the run.',
        query_duration_source: compatibleStats ? after.query_duration_source : null,
        server_delta: {
            cache_hits: hits,
            cache_misses: misses,
            cache_hit_rate: hits !== null && misses !== null && hits + misses > 0 ? hits / (hits + misses) : null,
            actual_candidate_queries: delta('random_query_duration_seconds', true),
            prefetch_queries: delta('random_prefetch_query_duration_seconds', true),
            resample_queries: delta('random_resample_queries_total'),
            resample_rejections: delta('random_resample_rejected_total'),
            resample_unresolved: delta('random_resample_unresolved_total'),
            fallback_selections: delta('random_fallback_total'),
            history_relaxations: delta('random_history_relaxations_total'),
            history_resets: delta('random_history_resets_total'),
        },
    };
}

if (require.main === module) {
    const [baseUrl, ...flags] = process.argv.slice(2);
    const names = { users: 'users', visits: 'visits', concurrency: 'concurrency', timeout: 'timeoutMs', tag: 'tag' };
    Promise.resolve().then(() => {
        if (!baseUrl) throw Error('Usage: node scripts/random-mvp-benchmark.js http://127.0.0.1:14515 --tag=life --users=20 --visits=50 --concurrency=8');
        const options = { baseUrl };
        for (const flag of flags) {
            const match = /^--([a-z]+)=(.*)$/.exec(flag);
            if (!match || !Object.hasOwn(names, match[1])) throw Error(`Unknown benchmark option: ${flag}`);
            options[names[match[1]]] = match[1] === 'tag' ? match[2] : Number(match[2]);
        }
        return runBenchmark(options);
    }).then(report => {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        if (report.failed_checks || report.recent_twenty_repeats) process.exitCode = 1;
    }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { runBenchmark };

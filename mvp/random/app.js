const express = require('express');
const cookieParser = require('cookie-parser');
const { createHybridRandomRouter } = require('../../routes/public/hybridRandom');
const { RandomMetrics } = require('../../modules/random/metrics');
const { BLOOM_BITS, BLOOM_HASHES } = require('../../modules/random/bloom');
const { CANDIDATE_LIMIT } = require('../../modules/random/select');
const { HISTORY_LIMIT, HISTORY_TTL_SECONDS } = require('../../modules/random/history');
const { measureCandidateQuery } = require('../../modules/random/source');

function createMvpApp({ database, cache, candidateSource, isDraining = () => false, cookieSecure = false, maxInFlight = 8, metrics = new RandomMetrics(), logger = console }) {
    const app = express();
    const startedAt = new Date().toISOString();
    const started = process.hrtime.bigint();
    app.disable('x-powered-by');
    app.use(cookieParser());
    app.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (isDraining()) {
            res.set('Connection', 'close');
            return res.status(503).json({ success: false, msg: '服务正在关闭，请稍后再试喵~' });
        }
        const origin = req.headers.origin;
        if (origin && /^https?:\/\/([a-zA-Z0-9-]+\.)*travellings\.cn$/.test(origin)) {
            res.set('Access-Control-Allow-Origin', origin);
            res.set('Access-Control-Allow-Credentials', 'true');
            res.vary('Origin');
        }
        next();
    });

    app.use('/random', createHybridRandomRouter({
        findCandidates: candidateSource ? candidateSource.findCandidates : measureCandidateQuery(database.findCandidates, metrics),
        metrics,
        cookieName: '_tvl_mvp',
        cookieSecure,
        maxInFlight,
        logger,
    }));

    let healthCheck;
    app.get('/health', async (req, res) => {
        // Concurrent probes share a query; probes are not random-request metrics.
        if (!healthCheck) {
            healthCheck = Promise.allSettled([
                Promise.resolve().then(() => database.check()),
                Promise.resolve().then(() => cache?.check()),
            ])
                .finally(() => { healthCheck = null; });
        }
        const [dbStatus, redisStatus] = await healthCheck;
        const ready = dbStatus.status === 'fulfilled' && redisStatus.status === 'fulfilled';
        res.status(ready ? 200 : 503).json({
            success: ready,
            status: ready ? 'ok' : 'unavailable',
            database: dbStatus.status === 'fulfilled' ? 'ready' : 'unavailable',
            redis: cache ? (redisStatus.status === 'fulfilled' ? 'ready' : 'unavailable') : 'disabled',
            redis_database: cache ? 5 : null,
        });
    });

    app.get('/stats', (req, res) => {
        res.json({
            service: 'hybrid-random-mvp',
            started_at: startedAt,
            uptime_seconds: Number(process.hrtime.bigint() - started) / 1e9,
            query_duration_source: database.kind,
            candidate_source: candidateSource?.kind || 'database',
            cache: candidateSource?.info || { enabled: false },
            algorithm: {
                candidate_limit: CANDIDATE_LIMIT,
                bloom_bits: BLOOM_BITS,
                bloom_hashes: BLOOM_HASHES,
                history_limit: HISTORY_LIMIT,
                history_ttl_seconds: HISTORY_TTL_SECONDS,
            },
            metrics: metrics.snapshot(),
        });
    });

    app.get('/metrics', (req, res) => {
        res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.send(metrics.toPrometheus());
    });
    app.use((req, res) => res.status(404).json({ success: false, msg: '未找到端点' }));
    return app;
}

module.exports = { createMvpApp };

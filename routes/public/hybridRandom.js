const express = require('express');
const { loadHistory, serializeHistory, appendHistory, relaxHistory, HISTORY_TTL_SECONDS } = require('../../modules/random/history');
const { selectCandidate, selectRelaxedCandidate, CANDIDATE_LIMIT } = require('../../modules/random/select');
const { validateSample } = require('../../modules/random/resample');
const { RandomMetrics } = require('../../modules/random/metrics');

function createHybridRandomRouter({
    findCandidates,
    resampleSource,
    metrics = new RandomMetrics(),
    cookieName = '_tvl',
    cookieSecure = false,
    maxInFlight = Infinity,
    nowSeconds = () => Math.floor(Date.now() / 1000),
    logger = console,
}) {
    if (typeof findCandidates !== 'function') throw new TypeError('A candidate source is required');
    const router = express.Router();
    let inFlight = 0;

    // Express otherwise executes GET handlers for HEAD, advancing visit history.
    router.head('/', (req, res) => res.set('Allow', 'GET').status(405).end());
    router.get('/', async (req, res) => {
        const started = process.hrtime.bigint();
        metrics.increment('random_requests_total');
        try {
            return await handleRequest(req, res);
        } finally {
            // Count logical processing even if the HTTP client disconnected.
            metrics.observeRequest(Number(process.hrtime.bigint() - started) / 1e9);
        }
    });

    async function handleRequest(req, res) {
        const tag = req.query.tag;
        if (tag !== undefined && (typeof tag !== 'string' || tag.length > 255)) {
            return res.status(400).json({ success: false, msg: 'tag 必须是长度不超过 255 的字符串喵~' });
        }
        if (inFlight >= maxInFlight) {
            res.set('Retry-After', '1');
            return res.status(503).json({ success: false, msg: '请求繁忙，请稍后再试喵~' });
        }

        inFlight++;
        try {
            const now = nowSeconds();
            const history = loadHistory(req.cookies?.[cookieName], now);
            const candidates = await findCandidates({ tag: tag || undefined });

            const selected = selectCandidate(candidates, history);
            let site = selected.site;
            metrics.increment('random_bloom_hits_total', selected.bloomHits);
            if (!site && candidates.length) {
                metrics.increment('random_resample_attempts_total');
                if (!resampleSource) throw new Error('A candidate-resampling source is required');
                try {
                    const rows = await resampleSource.findCandidates({ tag: tag || undefined });
                    validateSample(rows);
                    for (let offset = 0; offset < rows.length; offset += CANDIDATE_LIMIT) {
                        const next = selectCandidate(rows.slice(offset, offset + CANDIDATE_LIMIT), history);
                        metrics.increment('random_bloom_hits_total', next.bloomHits);
                        if (next.site) { site = next.site; break; }
                    }
                    if (!site) metrics.increment('random_resample_unresolved_total');
                } catch (error) {
                    // Budget refusal is recoverable using the batch already
                    // consumed. Database/Redis faults and shutdown still fail.
                    if (error.code !== 'RANDOM_RESAMPLE_BUDGET') throw error;
                }
                if (!site) {
                    const relaxed = selectRelaxedCandidate(candidates, history);
                    site = relaxed.site;
                    relaxHistory(history, relaxed.relaxation);
                    metrics.increment('random_fallback_total');
                    metrics.increment('random_history_relaxations_total');
                    if (relaxed.relaxation === 'all') metrics.increment('random_history_resets_total');
                }
            }
            if (!site) {
                return res.json({ success: false, msg: '暂时没有状态为 RUN 且该查询条件的站点喵~' });
            }

            appendHistory(history, site.id);
            res.cookie(cookieName, serializeHistory(history, nowSeconds()), {
                maxAge: HISTORY_TTL_SECONDS * 1000,
                httpOnly: true,
                sameSite: 'lax',
                secure: cookieSecure,
                path: '/random',
            });
            return res.json({
                success: true,
                data: [{ id: site.id, name: site.name, url: site.link, tag: site.tag }],
            });
        } catch (error) {
            if (error.code === 'RANDOM_RESAMPLE_BUDGET' || error.code === 'RANDOM_RESAMPLE_CLOSING') {
                res.set('Retry-After', '1');
                return res.status(503).json({ success: false, msg: '请求繁忙，请稍后再试喵~' });
            } else {
                metrics.increment('random_errors_total');
                logger.error('[RANDOM MVP]', error);
            }
            return res.status(503).json({ success: false, msg: '出错了呜呜呜~ 请检查控制台输出喵~' });
        } finally {
            inFlight--;
        }
    }

    return router;
}

module.exports = { createHybridRandomRouter };

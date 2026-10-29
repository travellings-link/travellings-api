const express = require('express');
const { loadHistory, serializeHistory, HISTORY_TTL_SECONDS } = require('../../modules/random/history');
const { selectCandidate } = require('../../modules/random/select');
const { RandomMetrics } = require('../../modules/random/metrics');

function createHybridRandomRouter({
    findCandidates,
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
        metrics.increment('random_requests_total');
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

            const { site, bloomHits, fallback } = selectCandidate(candidates, history);
            metrics.increment('random_bloom_hits_total', bloomHits);
            if (fallback) metrics.increment('random_fallback_total');
            if (!site) {
                return res.json({ success: false, msg: '暂时没有状态为 RUN 且该查询条件的站点喵~' });
            }

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
            metrics.increment('random_errors_total');
            logger.error('[RANDOM MVP]', error);
            return res.status(503).json({ success: false, msg: '出错了呜呜呜~ 请检查控制台输出喵~' });
        } finally {
            inFlight--;
        }
    });

    return router;
}

module.exports = { createHybridRandomRouter };

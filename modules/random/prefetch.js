const { createHash, randomInt, randomUUID } = require('node:crypto');
const { CANDIDATE_LIMIT } = require('./select');
const { performance } = require('node:perf_hooks');

const PREFETCH_LIMIT = 64;
const CACHE_PREFIX = 'travellings:random-mvp:v1:';

function cacheKey(tag) {
    const scope = tag ? `tag\0${tag}` : 'all';
    return `${CACHE_PREFIX}${createHash('sha256').update(scope).digest('hex')}`;
}

function buildBatches(rows) {
    if (!Array.isArray(rows) || rows.length > PREFETCH_LIMIT) {
        throw new TypeError('Expected at most 64 prefetched sites');
    }
    const batches = [];
    if (rows.length === PREFETCH_LIMIT) {
        // Consume each sampled row once; do not repeatedly share a fixed subset.
        for (let i = 0; i < rows.length; i += CANDIDATE_LIMIT) {
            batches.push(rows.slice(i, i + CANDIDATE_LIMIT));
        }
    } else {
        // Fewer than LIMIT rows means this is the entire eligible pool. Repeated
        // fresh samples of that complete pool also cache tiny and empty queries.
        for (let batch = 0; batch < PREFETCH_LIMIT / CANDIDATE_LIMIT; batch++) {
            const shuffled = rows.slice();
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = randomInt(i + 1);
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            batches.push(shuffled.slice(0, CANDIDATE_LIMIT));
        }
    }
    return batches;
}

function decodeBatch(raw) {
    if (typeof raw !== 'string' || raw.length > 256 * 1024) throw new Error('Invalid cached candidate batch');
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > CANDIDATE_LIMIT
        || rows.some(row => !row || !Number.isSafeInteger(row.id)
            || typeof row.name !== 'string' || typeof row.link !== 'string'
            || (row.tag !== null && typeof row.tag !== 'string'))
        || new Set(rows.map(row => row.id)).size !== rows.length) {
        throw new Error('Invalid cached candidate batch');
    }
    return rows;
}

function createPrefetchSource({ cache, prefetchCandidates, metrics, ttlSeconds = 30, lockMs = 15000, waitMs = 3000, now = () => performance.now() }) {
    const refills = new Map();
    const activeRequests = new Set();
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    let stopping = false;
    let closing;

    function closingError() {
        const error = new Error('Random candidate source is draining');
        error.code = 'RANDOM_PREFETCH_CLOSING';
        return error;
    }

    function checkOpen() {
        if (stopping) throw closingError();
    }

    function checkDeadline(deadline) {
        if (now() >= deadline) throw new Error('Random candidate cache refill timed out');
    }

    function waitForRefill(promise, deadline) {
        checkDeadline(deadline);
        return new Promise((resolve, reject) => {
            // This limits only a follower's wait, not the owner's MySQL query.
            const timer = setTimeout(() => reject(new Error('Random candidate cache refill timed out')), deadline - now());
            promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
        });
    }

    async function pop(key) {
        const raw = await cache.popBatch(key);
        return raw === null ? null : decodeBatch(raw);
    }

    async function refill(key, tag, deadline) {
        const lockKey = `${key}:lock`;
        const token = randomUUID();
        let attemptedLock = false;
        try {
            for (;;) {
                checkOpen();
                checkDeadline(deadline);
                attemptedLock = true;
                const acquired = await cache.acquireLock(lockKey, token, lockMs);
                checkDeadline(deadline);
                if (acquired) break;
                const batch = await pop(key);
                checkDeadline(deadline);
                if (batch !== null) return batch;
                await wait(Math.min(50, Math.max(0, deadline - now())));
            }
            checkOpen();
            // Another process may have populated the pool before we got its lock.
            const existing = await pop(key);
            if (existing !== null) return existing;
            checkOpen();
            checkDeadline(deadline);
            const started = process.hrtime.bigint();
            let rows;
            try {
                rows = await prefetchCandidates({ tag });
            } finally {
                metrics.observeQuery(Number(process.hrtime.bigint() - started) / 1e9);
            }
            const batches = buildBatches(rows);
            const first = batches.shift();
            const published = await cache.publishBatches(key, lockKey, token, batches.map(batch => JSON.stringify(batch)), ttlSeconds);
            if (!published) throw new Error('Random candidate cache refill lease expired');
            metrics.increment('random_cache_refills_total');
            return first;
        } finally {
            // Even a rejected SET can already have acquired the lock. Cleanup is
            // best effort: a delayed SET can still arrive later, so PX is required.
            if (attemptedLock) await cache.releaseLock(lockKey, token).catch(() => {});
        }
    }

    async function findCandidates({ tag } = {}) {
        checkOpen();
        const deadline = now() + waitMs;
        const key = cacheKey(tag);
        const first = await pop(key);
        if (first !== null) {
            metrics.increment('random_cache_hits_total');
            return first;
        }
        metrics.increment('random_cache_misses_total');
        for (;;) {
            checkOpen();
            checkDeadline(deadline);
            const pending = refills.get(key);
            if (pending) {
                await waitForRefill(pending, deadline);
                checkDeadline(deadline);
                const batch = await pop(key);
                checkDeadline(deadline);
                if (batch !== null) return batch;
                continue;
            }
            // Each owner performs at most one SQL query. The deadline persists
            // across all waits/rechecks; followers never get a fresh wait budget.
            const work = refill(key, tag, deadline).finally(() => { refills.delete(key); });
            refills.set(key, work);
            return work;
        }
    }

    return {
        kind: 'redis-prefetch',
        info: { enabled: true, database: 5, prefetch_limit: PREFETCH_LIMIT, candidate_limit: CANDIDATE_LIMIT, ttl_seconds: ttlSeconds },
        findCandidates(query) {
            if (stopping) return Promise.reject(closingError());
            const work = findCandidates(query).finally(() => { activeRequests.delete(work); });
            activeRequests.add(work);
            return work;
        },
        stopAccepting() { stopping = true; },
        close() {
            if (!closing) {
                stopping = true;
                closing = (async () => {
                    // HTTP sockets may already be gone. Drain logical work,
                    // including publish/release finally blocks, independently.
                    while (activeRequests.size || refills.size) {
                        await Promise.allSettled([...activeRequests, ...refills.values()]);
                    }
                })();
            }
            return closing;
        },
    };
}

module.exports = { createPrefetchSource, cacheKey, PREFETCH_LIMIT, CACHE_PREFIX };

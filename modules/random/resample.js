const { performance } = require('node:perf_hooks');
const { validId } = require('./history');

const RESAMPLE_LIMIT = 64;

function validateSample(rows) {
    if (!Array.isArray(rows) || rows.length > RESAMPLE_LIMIT
        || Array.from(rows).some(row => !row || !validId(row.id))
        || new Set(rows.map(row => row.id)).size !== rows.length) {
        throw new TypeError('Invalid candidate resample result');
    }
}

function createResampleSource({ resampleCandidates, metrics, maxInFlight = 1, ratePerSecond = 2, burst = 2,
    isDraining = () => false, now = () => performance.now() }) {
    if (typeof resampleCandidates !== 'function') throw new TypeError('A candidate-resampling source is required');
    for (const value of [maxInFlight, ratePerSecond, burst]) {
        if (!Number.isInteger(value) || value < 1) throw new TypeError('Invalid resample budget');
    }
    let tokens = burst;
    let updated = now();
    let stopping = false;
    let closing;
    const active = new Set();

    function reject(code, message) {
        const error = new Error(message);
        error.code = code;
        return Promise.reject(error);
    }

    return {
        info: { candidate_limit: RESAMPLE_LIMIT, max_in_flight: maxInFlight, rate_per_second: ratePerSecond, burst },
        findCandidates(query) {
            if (stopping || isDraining()) return reject('RANDOM_RESAMPLE_CLOSING', 'Candidate-resampling source is draining');
            const timestamp = now();
            tokens = Math.min(burst, tokens + Math.max(0, timestamp - updated) * ratePerSecond / 1000);
            updated = timestamp;
            // Refuse immediately: no unbounded queue, retry, or shared user history.
            if (active.size >= maxInFlight || tokens < 1) {
                metrics.increment('random_resample_rejected_total');
                return reject('RANDOM_RESAMPLE_BUDGET', 'Candidate-resampling budget is unavailable');
            }
            tokens--;
            metrics.increment('random_resample_queries_total');
            const started = process.hrtime.bigint();
            const work = (async () => {
                try {
                    const rows = await resampleCandidates(query);
                    validateSample(rows);
                    return rows;
                } catch (error) {
                    metrics.increment('random_resample_errors_total');
                    throw error;
                } finally {
                    metrics.observeQuery(Number(process.hrtime.bigint() - started) / 1e9, 'resample');
                }
            })().finally(() => { active.delete(work); });
            active.add(work);
            return work;
        },
        stopAccepting() { stopping = true; },
        close() {
            if (!closing) {
                stopping = true;
                closing = Promise.allSettled([...active]).then(() => {});
            }
            return closing;
        },
    };
}

module.exports = { createResampleSource, validateSample, RESAMPLE_LIMIT };

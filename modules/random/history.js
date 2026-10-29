const { BloomFilter } = require('./bloom');

const HISTORY_LIMIT = 15;
const HISTORY_TTL_SECONDS = 15 * 86400;
const HISTORY_VERSION = 1;

function emptyHistory() {
    return { bloom: new BloomFilter(), n: 0, lastId: null };
}

function loadHistory(raw, nowSeconds) {
    try {
        if (typeof raw !== 'string' || raw.length > 512) return emptyHistory();
        const state = JSON.parse(raw);
        if (!state || Array.isArray(state) || state.v !== HISTORY_VERSION
            || !Number.isInteger(state.n) || state.n < 1 || state.n > HISTORY_LIMIT
            || !Number.isSafeInteger(state.lastId)
            || !Number.isSafeInteger(state.t) || state.t < 0 || state.t > nowSeconds
            || nowSeconds - state.t >= HISTORY_TTL_SECONDS) {
            return emptyHistory();
        }
        return { bloom: BloomFilter.fromBase64(state.bf), n: state.n, lastId: state.lastId };
    } catch {
        // Expired or damaged cookies must not preserve an untrusted lastId.
        return emptyHistory();
    }
}

function serializeHistory(history, nowSeconds) {
    return JSON.stringify({
        v: HISTORY_VERSION,
        bf: history.bloom.toBase64(),
        n: history.n,
        lastId: history.lastId,
        t: nowSeconds,
    });
}

module.exports = { emptyHistory, loadHistory, serializeHistory, HISTORY_LIMIT, HISTORY_TTL_SECONDS };

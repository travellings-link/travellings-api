const { BloomFilter } = require('./bloom');

const HISTORY_LIMIT = 20;
const HISTORY_TTL_SECONDS = 15 * 86400;
const HISTORY_VERSION = 3;

const validId = id => Number.isInteger(id) && id > 0 && id <= 2147483647;

function emptyHistory() {
    return { current: new BloomFilter(), previous: new BloomFilter(), n: 0, lastId: null };
}

function loadHistory(raw, nowSeconds) {
    try {
        if (typeof raw !== 'string' || raw.length > 512) return emptyHistory();
        const state = JSON.parse(raw);
        if (!state || Array.isArray(state) || state.v !== HISTORY_VERSION
            || !Number.isInteger(state.n) || state.n < 0 || state.n >= HISTORY_LIMIT
            || !validId(state.lastId)
            || !Number.isSafeInteger(state.t) || state.t < 0 || state.t > nowSeconds
            || nowSeconds - state.t >= HISTORY_TTL_SECONDS) {
            return emptyHistory();
        }
        const current = BloomFilter.fromBase64(state.bf);
        const previous = BloomFilter.fromBase64(state.prev);
        if (state.n === 0 ? current.bytes.some(byte => byte !== 0) || !previous.has(state.lastId) : !current.has(state.lastId)) {
            return emptyHistory();
        }
        return { current, previous, n: state.n, lastId: state.lastId };
    } catch {
        // Old single-generation Bloom/FIFO cookies do not establish this window.
        return emptyHistory();
    }
}

function serializeHistory(history, nowSeconds) {
    return JSON.stringify({
        v: HISTORY_VERSION,
        bf: history.current.toBase64(),
        prev: history.previous.toBase64(),
        n: history.n,
        lastId: history.lastId,
        t: nowSeconds,
    });
}

function appendHistory(history, id) {
    if (!validId(id)) throw new TypeError('Invalid selected site ID');
    history.current.add(id);
    history.n++;
    history.lastId = id;
    if (history.n === HISTORY_LIMIT) {
        // Rotate immediately after the twentieth success, keeping the entire
        // new previous generation. Normal rotation never discards the last twenty.
        history.previous = history.current;
        history.current = new BloomFilter();
        history.n = 0;
    }
}

function relaxHistory(history, relaxation) {
    if (!['previous', 'all'].includes(relaxation)) throw new TypeError('Invalid history relaxation');
    history.previous = new BloomFilter();
    if (relaxation === 'all') {
        history.current = new BloomFilter();
        history.n = 0;
    }
    // Preserve lastId until the selected result is appended successfully.
}

module.exports = { emptyHistory, loadHistory, serializeHistory, appendHistory, relaxHistory, validId, HISTORY_LIMIT, HISTORY_TTL_SECONDS, HISTORY_VERSION };

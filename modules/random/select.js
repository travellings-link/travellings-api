const { BloomFilter } = require('./bloom');
const { HISTORY_LIMIT } = require('./history');

const CANDIDATE_LIMIT = 8;

function selectCandidate(candidates, history) {
    if (!Array.isArray(candidates) || candidates.length > CANDIDATE_LIMIT) {
        throw new TypeError('Expected at most eight random candidates');
    }
    if (history.n >= HISTORY_LIMIT) {
        history.bloom = new BloomFilter();
        history.n = 0;
        // Normal rotation preserves lastId independently of the Bloom bits.
    }

    let site = null;
    let bloomHits = 0;
    let fallback = false;
    for (const candidate of candidates) {
        const hit = history.bloom.has(candidate.id);
        if (hit) bloomHits++;
        if (!hit && candidate.id !== history.lastId) {
            site = candidate;
            break;
        }
    }

    if (!site && candidates.length > 0) {
        fallback = true;
        site = candidates.find(candidate => candidate.id !== history.lastId) || candidates[0];
        history.bloom = new BloomFilter();
        history.n = 0;
    }

    if (site) {
        history.bloom.add(site.id);
        history.n++;
        history.lastId = site.id;
    }
    return { site, bloomHits, fallback };
}

module.exports = { selectCandidate, CANDIDATE_LIMIT };

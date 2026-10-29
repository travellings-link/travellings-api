const { validId } = require('./history');

const CANDIDATE_LIMIT = 8;

function validateCandidates(candidates) {
    if (!Array.isArray(candidates) || candidates.length > CANDIDATE_LIMIT
        || Array.from(candidates).some(candidate => !candidate || !validId(candidate.id))
        || new Set(candidates.map(candidate => candidate.id)).size !== candidates.length) {
        throw new TypeError('Expected at most eight distinct valid random candidates');
    }
}

function selectCandidate(candidates, history) {
    validateCandidates(candidates);
    let bloomHits = 0;
    for (const candidate of candidates) {
        const hit = history.current.has(candidate.id) || history.previous.has(candidate.id);
        if (hit) bloomHits++;
        if (!hit && candidate.id !== history.lastId) return { site: candidate, bloomHits };
    }
    return { site: null, bloomHits };
}

function selectRelaxedCandidate(candidates, history) {
    validateCandidates(candidates);
    const choices = candidates.filter(candidate => candidate.id !== history.lastId);
    const site = choices.find(candidate => !history.current.has(candidate.id));
    if (site) return { site, relaxation: 'previous' };
    return { site: choices[0] || candidates[0] || null, relaxation: 'all' };
}

module.exports = { selectCandidate, selectRelaxedCandidate, CANDIDATE_LIMIT };

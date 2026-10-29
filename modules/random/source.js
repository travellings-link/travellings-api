const { Sequelize, Op } = require('sequelize');
const { CANDIDATE_LIMIT } = require('./select');

// Accepts either the main application's webModel or the MVP's read-only model.
function createCandidateSource(webModel, { limit = CANDIDATE_LIMIT } = {}) {
    return async function findCandidates({ tag } = {}) {
        const where = { status: 'RUN' };
        if (tag) where.tag = { [Op.like]: `%${tag}%` };
        return webModel.findAll({
            attributes: ['id', 'name', 'link', 'tag'],
            where,
            order: Sequelize.literal('RAND()'),
            limit,
            raw: true,
        });
    };
}

function measureCandidateQuery(findCandidates, metrics) {
    return async query => {
        const started = process.hrtime.bigint();
        try {
            return await findCandidates(query);
        } finally {
            metrics.observeQuery(Number(process.hrtime.bigint() - started) / 1e9);
        }
    };
}

module.exports = { createCandidateSource, measureCandidateQuery };

// ____                 _
// |  _ \ __ _ _ __   __| | ___  _ __ ___
// | |_) / _` | '_ \ / _` |/ _ \| '_ ` _ \
// |  _ < (_| | | | | (_| | (_) | | | | | |
// |_| \_\__,_|_| |_|\__,_|\___/|_| |_| |_|
//
// By BLxcwg666 <huixcwg@gmail.com>

const crypto = require('crypto');
const express = require("express");
const log = require('../../modules/logger');
const { Op } = require('sequelize');
const { webModel } = require('../../modules/sqlModel');

const router = express.Router();

// ── constants ────────────────────────────────────────────────────────────────
const COOKIE_NAME = '_tvl_s';       // single cookie stores seed + position + history
const MAX_HISTORY = 10;             // exclude up to 10 recently-visited IDs
const SEED_TTL_SEC = 15 * 86400;   // reshuffle every 15 days
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── 32‑bit LCG for deterministic pseudo‑random numbers ──────────────────────
function nextRand(seed) {
    // LCG parameters (ANSI C / glibc)
    return ((seed * 1103515245 + 12345) >>> 0);
}

// ── Fisher–Yates shuffle driven by a seed ───────────────────────────────────
function seededShuffle(arr, seed) {
    const result = [...arr];
    let s = seed >>> 0;
    for (let i = result.length - 1; i > 0; i--) {
        s = nextRand(s);
        const j = s % (i + 1);
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

// ── cookie helpers ──────────────────────────────────────────────────────────
function parseState(req) {
    try {
        const raw = req.cookies[COOKIE_NAME];
        if (!raw) return null;
        const state = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
        // must have at least a valid seed and position
        if (typeof state.s !== 'number' || typeof state.p !== 'number') return null;
        return state; // shape: { s:seed, p:position, h:[…], t:timestamp }
    } catch {
        return null;
    }
}

function setStateCookie(res, state) {
    res.cookie(COOKIE_NAME,
        Buffer.from(JSON.stringify(state)).toString('base64'), {
            maxAge: STATE_TTL_MS,
            httpOnly: true,
            sameSite: 'lax',
            secure: res.req.secure || (res.req.protocol === 'https'),
            path: '/random',
        });
}

// ── route ───────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const tag = req.query.tag;

        // ── 1. read or create client state ──────────────────────────────────
        let state = parseState(req);
        const nowSec = Math.floor(Date.now() / 1000);

        if (!state || (nowSec - state.t > SEED_TTL_SEC)) {
            // crypto.randomInt gives true entropy for the initial seed,
            // avoiding the "always the same first value" problem of simple PRNGs.
            state = {
                s: crypto.randomInt(0, 0x7FFFFFFF),
                p: 0,
                h: [],
                t: nowSec,
            };
        }

        // ── 2. fetch all eligible IDs (lightweight — id column only) ────────
        const baseWhere = { status: 'RUN' };
        if (tag) baseWhere.tag = { [Op.like]: `%${tag}%` };

        const rows = await webModel.findAll({
            attributes: ['id'],
            where: baseWhere,
            raw: true,
        });

        if (rows.length === 0) {
            return res.json({ success: false, msg: "暂时没有状态为 RUN 且该查询条件的站点喵~" });
        }

        const allIds = rows.map(r => r.id);

        // ── 3. deterministic shuffle → pick first non-visited ───────────────
        const shuffled = seededShuffle(allIds, state.s);
        const len = shuffled.length;
        const histSet = new Set(state.h);

        let chosenId = null;
        let chosenIdx = state.p % len;

        for (let i = 0; i < len; i++) {
            const candidateIdx = (chosenIdx + i) % len;
            const candidateId = shuffled[candidateIdx];
            if (!histSet.has(candidateId)) {
                chosenId = candidateId;
                chosenIdx = candidateIdx;
                break;
            }
        }

        // all IDs are in history → fall back to the current position
        if (chosenId === null) {
            chosenIdx = state.p % len;
            chosenId = shuffled[chosenIdx];
        }

        // ── 4. fetch full record ────────────────────────────────────────────
        const web = await webModel.findByPk(chosenId);

        if (!web) {
            // deleted between findAll and findByPk — skip it
            state.h = [];
            state.p = (state.p + 1) % len;
            setStateCookie(res, state);
            return res.json({ success: false, msg: "站点已失效，请再试一次喵~" });
        }

        // ── 5. update state & respond ───────────────────────────────────────
        state.p = chosenIdx + 1;                          // advance past picked position
        state.h = [chosenId, ...state.h.filter(id => id !== chosenId)].slice(0, MAX_HISTORY);
        state.t = nowSec;

        setStateCookie(res, state);
        res.json({
            success: true,
            data: [{ id: web.id, name: web.name, url: web.link, tag: web.tag }],
        });

    } catch (error) {
        log.err(error, "RANDOM");
        res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
    }
});

module.exports = router;

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

// ── Bloom filter — compact, privacy-friendly dedup (stored in cookie) ─────
const BF_BITS    = 320;          // 40 bytes
const BF_HASHES  = 6;
const MAX_HIST   = 15;           // cycle after 15 visits
const TTL_SEC     = 15 * 86400;  // cookie age
const COOKIE_NAME = '_tvl';

class BloomFilter {
    constructor(bits = BF_BITS, hashes = BF_HASHES) {
        this.size = bits;
        this.numHashes = hashes;
        this.bytes = Buffer.alloc(Math.ceil(bits / 8));
    }

    _hash(item, seed) {
        const h = crypto.createHash('sha256')
            .update(String(item) + '\x00' + seed)
            .digest();
        return h.readUInt32BE(0) % this.size;
    }

    add(item) {
        for (let i = 0; i < this.numHashes; i++) {
            const idx = this._hash(item, i);
            this.bytes[idx >> 3] |= (1 << (idx & 7));
        }
    }

    /** false → definitely NOT in set; true → MAYBE in set */
    test(item) {
        for (let i = 0; i < this.numHashes; i++) {
            const idx = this._hash(item, i);
            if (!(this.bytes[idx >> 3] & (1 << (idx & 7)))) return false;
        }
        return true;
    }

    toBase64()  { return this.bytes.toString('base64'); }

    static fromBase64(str) {
        const bf = new BloomFilter();
        try {
            const buf = Buffer.from(str, 'base64');
            buf.copy(bf.bytes, 0, 0, Math.min(buf.length, bf.bytes.length));
        } catch { /* corrupted → empty */ }
        return bf;
    }
}

// ── cookie helpers ──────────────────────────────────────────────────────────
function loadState(req) {
    try {
        const raw = req.cookies[COOKIE_NAME];
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (typeof s.bf !== 'string' || typeof s.n !== 'number') return null;
        return s;   // { bf, n, t }
    } catch { return null; }
}

function saveState(res, bf, n, nowSec) {
    const state = { bf: bf.toBase64(), n, t: nowSec };
    res.cookie(COOKIE_NAME, JSON.stringify(state), {
        maxAge: TTL_SEC * 1000,
        httpOnly: true,
        sameSite: 'lax',
        secure: res.req.secure || (res.req.protocol === 'https'),
        path: '/random',
    });
}

// ── browser fingerprint (zero storage, derived from request headers) ───────
function getFingerprint(req) {
    const ip   = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
              || req.socket?.remoteAddress
              || req.ip
              || '';
    const ua   = req.headers['user-agent'] || '';
    const lang = req.headers['accept-language'] || '';
    return ip + '|' + ua + '|' + lang;
}

// ── daily offset from fingerprint + date ────────────────────────────────────
function dailyOffset(fp, dateStr, total) {
    const h = crypto.createHash('sha256').update(fp + '\x00' + dateStr).digest();
    return h.readUIntBE(0, 6) % total;   // 48-bit uniform
}

// ── route ───────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        // ── 1. init bloom filter from cookie ────────────────────────────────
        let state = loadState(req);
        const nowSec = Math.floor(Date.now() / 1000);
        let bf, histN;

        if (state && (nowSec - (state.t || 0) < TTL_SEC) && state.n < MAX_HIST) {
            bf    = BloomFilter.fromBase64(state.bf);
            histN = state.n;
        } else {
            bf    = new BloomFilter();  // expired / full → reset
            histN = 0;
        }

        // ── 2. build query condition ────────────────────────────────────────
        const tag = req.query.tag;
        const where = { status: 'RUN' };
        if (tag) where.tag = { [Op.like]: `%${tag}%` };

        // ── 3. count eligible sites ─────────────────────────────────────────
        const total = await webModel.count({ where });
        if (total === 0) {
            return res.json({ success: false, msg: "暂时没有状态为 RUN 且该查询条件的站点喵~" });
        }

        // ── 4. daily offset derived from browser fingerprint ────────────────
        const fp       = getFingerprint(req);
        const dateStr  = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
        const baseOff  = dailyOffset(fp, dateStr, total);

        // ── 5. probe — walk forward skipping bloom‑filter hits ──────────────
        let web = null;
        for (let i = 0; i < total; i++) {
            const candidate = await webModel.findOne({
                where,
                offset: (baseOff + i) % total,
                raw: true,
            });
            if (!candidate) break;
            if (!bf.test(candidate.id)) {
                web = candidate;
                break;
            }
        }

        // ── 6. fallback — all filtered (extreme edge case) ──────────────────
        if (!web) {
            web = await webModel.findOne({ where, offset: baseOff, raw: true });
        }

        if (!web) {
            return res.json({ success: false, msg: "站点已失效，请再试一次喵~" });
        }

        // ── 7. update bloom filter & cycle if full ──────────────────────────
        bf.add(web.id);
        histN++;
        if (histN >= MAX_HIST) {
            bf = new BloomFilter();
            bf.add(web.id);
            histN = 1;
        }

        // ── 8. respond ──────────────────────────────────────────────────────
        saveState(res, bf, histN, nowSec);
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

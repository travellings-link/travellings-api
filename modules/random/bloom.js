const { createHash } = require('node:crypto');

const BLOOM_BITS = 320;
const BLOOM_HASHES = 6;
const BLOOM_BYTES = BLOOM_BITS / 8;

class BloomFilter {
    constructor(bytes = Buffer.alloc(BLOOM_BYTES)) {
        if (!Buffer.isBuffer(bytes) || bytes.length !== BLOOM_BYTES) {
            throw new TypeError('Invalid Bloom filter size');
        }
        this.bytes = Buffer.from(bytes);
    }

    index(id, seed) {
        return createHash('sha256').update(`${id}\0${seed}`).digest().readUInt32BE(0) % BLOOM_BITS;
    }

    add(id) {
        for (let seed = 0; seed < BLOOM_HASHES; seed++) {
            const index = this.index(id, seed);
            this.bytes[index >> 3] |= 1 << (index & 7);
        }
    }

    has(id) {
        for (let seed = 0; seed < BLOOM_HASHES; seed++) {
            const index = this.index(id, seed);
            if (!(this.bytes[index >> 3] & (1 << (index & 7)))) return false;
        }
        return true;
    }

    toBase64() {
        return this.bytes.toString('base64');
    }

    static fromBase64(value) {
        if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{54}==$/.test(value)) {
            throw new TypeError('Invalid Bloom filter encoding');
        }
        const bytes = Buffer.from(value, 'base64');
        if (bytes.length !== BLOOM_BYTES || bytes.toString('base64') !== value) {
            throw new TypeError('Invalid Bloom filter encoding');
        }
        return new BloomFilter(bytes);
    }
}

module.exports = { BloomFilter, BLOOM_BITS, BLOOM_HASHES };

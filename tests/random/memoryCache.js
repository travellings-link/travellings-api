class MemoryCache {
    constructor() {
        this.database = 5;
        this.pools = new Map();
        this.locks = new Map();
        this.now = 0;
        this.online = true;
        this.closed = 0;
    }

    assertOnline() { if (!this.online) throw new Error('Redis unavailable'); }
    async connect() { this.assertOnline(); }
    async check() { this.assertOnline(); }
    async close() { this.closed++; }
    async popBatch(key) {
        this.assertOnline();
        const pool = this.pools.get(key);
        if (!pool || pool.expires <= this.now) { this.pools.delete(key); return null; }
        return pool.batches.shift() ?? null;
    }
    async acquireLock(key, token, leaseMs) {
        this.assertOnline();
        const lock = this.locks.get(key);
        if (lock && lock.expires > this.now) return null;
        this.locks.set(key, { token, expires: this.now + leaseMs });
        return 'OK';
    }
    async publishBatches(key, lockKey, token, batches, ttlSeconds) {
        this.assertOnline();
        const lock = this.locks.get(lockKey);
        if (!lock || lock.expires <= this.now || lock.token !== token) return 0;
        this.pools.set(key, { batches: batches.slice(), expires: this.now + ttlSeconds * 1000 });
        this.locks.delete(lockKey);
        return 1;
    }
    async releaseLock(key, token) {
        this.assertOnline();
        if (this.locks.get(key)?.token === token) this.locks.delete(key);
    }
}

module.exports = { MemoryCache };

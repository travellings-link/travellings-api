const { createClient } = require('redis');

const REDIS_DATABASE = 5;
const PUBLISH_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
for i = 3, #ARGV do redis.call('RPUSH', KEYS[1], ARGV[i]) end
if #ARGV > 2 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
redis.call('DEL', KEYS[2])
return 1`;
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0`;

function createRedisCache(config, logger = console, clientFactory = createClient) {
    const client = clientFactory({
        socket: {
            host: config.host,
            port: config.port,
            connectTimeout: config.timeoutMs,
            reconnectStrategy: retries => Math.min(100 * (retries + 1), 2000),
        },
        username: config.username || undefined,
        password: config.password || undefined,
        database: REDIS_DATABASE,
        disableOfflineQueue: true,
        commandsQueueMaxLength: 64,
    });
    let lastError = -Infinity;
    const active = new Set();
    let stopping = false;
    let closing;
    client.on('error', error => {
        if (Date.now() - lastError > 10000) {
            lastError = Date.now();
            logger.error('[RANDOM MVP REDIS]', error.message);
        }
    });

    function bounded(operation, action, { timeoutMs = config.timeoutMs, mutates = false, onLateSuccess } = {}) {
        if (stopping) return Promise.reject(new Error('Random MVP Redis connection is draining'));
        const result = new Promise((resolve, reject) => {
            let finished = false;
            let timedOut = false;
            const timer = setTimeout(() => {
                finished = true;
                timedOut = true;
                const error = new Error(`Random MVP Redis operation timed out: ${operation}`);
                error.code = 'RANDOM_REDIS_TIMEOUT';
                error.operation = operation;
                // Sent mutations may already be committed. Never infer failure
                // or transparently retry LPOP/SET/publish after a missing reply.
                error.outcomeUnknown = mutates;
                reject(error);
            }, timeoutMs);
            Promise.resolve().then(action).then(value => {
                if (finished) {
                    if (timedOut && onLateSuccess && !stopping) {
                        // Only token-checked unlock is safe to retry. TTL still
                        // covers lost acknowledgements and cleanup failures.
                        onLateSuccess(value).catch(() => {});
                    }
                    return;
                }
                finished = true;
                clearTimeout(timer);
                resolve(value);
            }, error => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                reject(error);
            });
        });
        const tracked = result.finally(() => { active.delete(tracked); });
        active.add(tracked);
        return tracked;
    }

    function releaseLock(key, token) {
        return bounded('releaseLock', () => client.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] }), { mutates: true });
    }

    return Object.freeze({
        database: REDIS_DATABASE,
        async connect() {
            try {
                await bounded('connect', () => client.connect(), { timeoutMs: config.timeoutMs * 2 });
            } catch (error) {
                if (client.isOpen) await client.disconnect();
                throw error;
            }
        },
        check: () => bounded('ping', () => client.ping()),
        popBatch: key => bounded('popBatch', () => client.lPop(key), { mutates: true }),
        acquireLock: (key, token, leaseMs) => bounded('acquireLock', () => client.set(key, token, { NX: true, PX: leaseMs }), {
            mutates: true,
            onLateSuccess: value => value === 'OK' ? releaseLock(key, token) : Promise.resolve(),
        }),
        publishBatches: (key, lockKey, token, batches, ttlSeconds) => bounded('publishBatches', () => client.eval(PUBLISH_SCRIPT, {
            keys: [key, lockKey], arguments: [token, String(ttlSeconds), ...batches],
        }), { mutates: true }),
        releaseLock,
        close() {
            if (!closing) {
                stopping = true;
                closing = (async () => {
                    while (active.size) await Promise.allSettled([...active]);
                    // Unacknowledged wire operations cannot be awaited forever.
                    // Disconnect settles the driver queue; leases retain their TTL.
                    if (client.isOpen) await client.disconnect();
                })();
            }
            return closing;
        },
    });
}

module.exports = { createRedisCache, REDIS_DATABASE };

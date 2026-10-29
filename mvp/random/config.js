const path = require('node:path');

function integer(env, name, fallback, min, max) {
    const raw = env[name] ?? String(fallback);
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be between ${min} and ${max}`);
    }
    return value;
}

function readConfig(env = process.env) {
    for (const name of ['RANDOM_MVP_DB_NAME', 'RANDOM_MVP_DB_USER']) {
        if (!env[name]) throw new Error(`${name} is required; use a dedicated SELECT-only account`);
    }
    const secure = env.RANDOM_MVP_COOKIE_SECURE ?? 'false';
    if (!['true', 'false'].includes(secure)) throw new Error('RANDOM_MVP_COOKIE_SECURE must be true or false');
    if ((env.RANDOM_MVP_REDIS_DB ?? '5') !== '5') throw new Error('RANDOM_MVP_REDIS_DB must be 5');
    const queryTimeoutMs = integer(env, 'RANDOM_MVP_QUERY_TIMEOUT_MS', 2000, 1, 60000);
    return {
        host: env.RANDOM_MVP_HOST || '127.0.0.1',
        port: integer(env, 'RANDOM_MVP_PORT', 14515, 1, 65535),
        cookieSecure: secure === 'true',
        maxInFlight: integer(env, 'RANDOM_MVP_MAX_IN_FLIGHT', 8, 1, 64),
        cacheTtlSeconds: integer(env, 'RANDOM_MVP_CACHE_TTL_SECONDS', 30, 1, 300),
        redis: {
            host: env.RANDOM_MVP_REDIS_HOST || '127.0.0.1',
            port: integer(env, 'RANDOM_MVP_REDIS_PORT', 6379, 1, 65535),
            username: env.RANDOM_MVP_REDIS_USERNAME || '',
            password: env.RANDOM_MVP_REDIS_PASSWORD || '',
            database: 5,
            timeoutMs: integer(env, 'RANDOM_MVP_REDIS_TIMEOUT_MS', 1000, 100, 5000),
        },
        database: {
            host: env.RANDOM_MVP_DB_HOST || '127.0.0.1',
            port: integer(env, 'RANDOM_MVP_DB_PORT', 3306, 1, 65535),
            name: env.RANDOM_MVP_DB_NAME,
            user: env.RANDOM_MVP_DB_USER,
            password: env.RANDOM_MVP_DB_PASSWORD || '',
            poolMax: integer(env, 'RANDOM_MVP_DB_POOL_MAX', 4, 1, 16),
            queryTimeoutMs,
            clientQueryTimeoutMs: integer(env, 'RANDOM_MVP_QUERY_CLIENT_TIMEOUT_MS', queryTimeoutMs + 1000, 1, 120000),
        },
    };
}

function loadConfig() {
    // Never load the production .env or silently reuse its database credentials.
    const envPath = process.env.RANDOM_MVP_ENV_FILE || path.join(__dirname, '.env');
    const result = require('dotenv').config({ path: envPath });
    if (result.error && (process.env.RANDOM_MVP_ENV_FILE || result.error.code !== 'ENOENT')) {
        throw result.error;
    }
    return readConfig();
}

module.exports = { readConfig, loadConfig };

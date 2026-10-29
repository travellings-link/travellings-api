const { loadConfig } = require('./config');
const { createReadOnlyDatabase } = require('./database');
const { createMvpApp } = require('./app');
const { createRedisCache } = require('./redis');
const { createPrefetchSource } = require('../../modules/random/prefetch');
const { RandomMetrics } = require('../../modules/random/metrics');

async function start({ config = loadConfig(), createDatabase = createReadOnlyDatabase, createCache = createRedisCache, logger = console } = {}) {
    const database = createDatabase(config.database);
    let cache;
    let server;
    let candidateSource;
    let stopping = false;
    try {
        await database.check();
        cache = createCache(config.redis, logger);
        await cache.connect();
        await cache.check();
        const metrics = new RandomMetrics();
        candidateSource = createPrefetchSource({
            cache,
            prefetchCandidates: database.prefetchCandidates,
            metrics,
            ttlSeconds: config.cacheTtlSeconds,
            // Allow pool acquisition, handshake, session setup and the query;
            // the lease itself never serves as MySQL cancellation.
            lockMs: 10000 + (config.database.clientQueryTimeoutMs ?? 3000) * 3 + config.redis.timeoutMs * 4 + 2000,
        });
        const app = createMvpApp({ database, cache, candidateSource, metrics, isDraining: () => stopping, cookieSecure: config.cookieSecure, maxInFlight: config.maxInFlight, logger });
        server = await new Promise((resolve, reject) => {
            const listening = app.listen(config.port, config.host, () => resolve(listening));
            listening.once('error', reject);
        });
    } catch (error) {
        await candidateSource?.close();
        const cleanup = await Promise.allSettled([database.close(), cache?.close()]);
        for (const result of cleanup) {
            if (result.status === 'rejected') logger.error('Random MVP startup cleanup failed:', result.reason);
        }
        throw error;
    }

    logger.info(`Hybrid Random MVP listening on ${config.host}:${server.address().port}`);
    let closing;
    return {
        server,
        close() {
            if (!closing) {
                stopping = true;
                candidateSource.stopAccepting();
                closing = (async () => {
                    const timeout = setTimeout(() => server.closeAllConnections?.(), 10000);
                    timeout.unref();
                    const httpClosed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
                    server.closeIdleConnections?.();
                    let results;
                    try {
                        results = await Promise.allSettled([httpClosed, candidateSource.close()]);
                    } finally {
                        clearTimeout(timeout);
                    }
                    const resources = await Promise.allSettled([database.close(), cache.close()]);
                    const errors = [...results, ...resources].filter(result => result.status === 'rejected').map(result => result.reason);
                    if (errors.length) throw new AggregateError(errors, 'Random MVP shutdown failed');
                })();
            }
            return closing;
        },
    };
}

if (require.main === module) {
    start().then(runtime => {
        const stop = () => runtime.close().catch(error => {
            console.error('Random MVP shutdown failed:', error.message);
            process.exitCode = 1;
        });
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    }).catch(error => {
        console.error('Random MVP failed to start:', error.message);
        process.exitCode = 1;
    });
}

module.exports = { start };

const { EventEmitter } = require('node:events');
const mysql2 = require('mysql2');

function destroyMysqlConnection(connection) {
    try {
        connection.destroy();
    } finally {
        // mysql2 3.9.2 destroy() aliases close()/stream.end(). A half-close
        // alone is insufficient when the peer remains silent indefinitely.
        connection.stream?.destroy();
    }
}

function createGuardedMysql({ queryTimeoutMs, connectTimeoutMs = 5000 }, driver = mysql2) {
    const timedOut = new WeakSet();

    return {
        didTimeout: connection => timedOut.has(connection),
        dialectModule: {
            createConnection(config) {
                const connection = driver.createConnection(config);
                const pending = new Set();
                let terminalError;
                let connectTimer;

                function clearConnectTimer() {
                    clearTimeout(connectTimer);
                    connection.removeListener('connect', clearConnectTimer);
                    connection.removeListener('error', clearConnectTimer);
                }

                function expire(operation, timeoutMs) {
                    if (terminalError) return;
                    const error = new Error(`MySQL client ${operation} deadline exceeded (${timeoutMs} ms)`);
                    error.code = 'RANDOM_MYSQL_CLIENT_TIMEOUT';
                    error.fatal = true;
                    error.syscall = operation;
                    terminalError = error;
                    timedOut.add(connection);
                    clearConnectTimer();
                    try {
                        destroyMysqlConnection(connection);
                    } catch (cause) {
                        error.cause = cause;
                    } finally {
                        // Closing mysql2's socket does not necessarily invoke the
                        // in-flight callback. Settle every waiter exactly once.
                        for (const finish of [...pending]) finish(error);
                    }
                    if (operation === 'connect') connection.emit('error', error);
                }

                for (const method of ['query', 'execute']) {
                    const original = connection[method];
                    connection[method] = function (...args) {
                        const callback = args.pop();
                        if (typeof callback !== 'function') {
                            throw new TypeError('MVP MySQL operations require a completion callback');
                        }
                        if (terminalError) {
                            queueMicrotask(() => callback(terminalError));
                            return new EventEmitter();
                        }
                        let finished = false;
                        const timer = setTimeout(() => expire(method, queryTimeoutMs), queryTimeoutMs);
                        function finish(error, ...values) {
                            if (finished) return;
                            finished = true;
                            clearTimeout(timer);
                            pending.delete(finish);
                            callback(terminalError || error, ...values);
                        }
                        pending.add(finish);
                        try {
                            // execute() includes its prepare phase in this deadline.
                            return original.call(connection, ...args, finish);
                        } catch (error) {
                            finished = true;
                            clearTimeout(timer);
                            pending.delete(finish);
                            throw error;
                        }
                    };
                }

                // mysql2's connectTimeout may clear on partial handshake data.
                // This deadline covers completion of the complete handshake.
                connectTimer = setTimeout(() => expire('connect', connectTimeoutMs), connectTimeoutMs);
                connection.once('connect', clearConnectTimer);
                connection.once('error', clearConnectTimer);
                connection.stream?.once('close', clearConnectTimer);
                return connection;
            },
        },
    };
}

module.exports = { createGuardedMysql, destroyMysqlConnection };

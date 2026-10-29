const mysql2 = require('mysql2');
const { EventEmitter } = require('node:events');

function columns(names) {
    return names.map(name => ({
        catalog: 'def', schema: '', table: '', orgTable: '', name, orgName: name,
        characterSet: 45, columnLength: 255, columnType: name === 'id' ? 3 : 253, flags: 0, decimals: 0,
    }));
}

async function startMysqlFaultServer(t) {
    const state = {
        events: new EventEmitter(), sockets: [], queries: [], candidateConnections: [],
        stallCandidates: false, stallSessionSetup: false, stallHealth: false,
    };
    const server = mysql2.createServer(connection => {
        state.sockets.push(connection.stream);
        connection.on('error', () => {});
        connection.serverHandshake({
            protocolVersion: 10, serverVersion: '8.0.36', connectionId: state.sockets.length,
            statusFlags: 2, characterSet: 45,
            capabilityFlags: (1 << 0) | (1 << 3) | (1 << 9) | (1 << 13) | (1 << 15) | (1 << 19),
            authCallback: (params, callback) => { callback(null); connection._resetSequenceId(); },
        });
        function result(names, rows = []) {
            connection.writeColumns(columns(names));
            for (const row of rows) connection.writeTextRow(row);
            connection.writeEof();
            connection._resetSequenceId();
        }
        connection.on('stmt_prepare', sql => {
            state.queries.push(sql);
            if (/^SET /i.test(sql)) {
                if (state.stallSessionSetup && /transaction_read_only/.test(sql)) {
                    state.events.emit('stalled', connection);
                    return;
                }
                connection.writeOk();
                connection._resetSequenceId();
            } else {
                // Deliberately never answer COM_STMT_PREPARE.
                state.events.emit('prepared-stalled', connection);
            }
        });
        connection.on('query', sql => {
            state.queries.push(sql);
            if (/VERSION\(\)/i.test(sql)) return result(['version'], [['8.0.36']]);
            if (/ORDER BY RAND\(\)/i.test(sql)) {
                state.candidateConnections.push(connection);
                state.events.emit('candidate', connection);
                if (state.stallCandidates) return;
                return result(['id', 'name', 'link', 'tag'], [[1, 'test site', 'https://example.test', 'blog']]);
            }
            if (state.stallHealth) {
                state.events.emit('stalled', connection);
                return;
            }
            return result(['id', 'status', 'name', 'link', 'tag']);
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    state.port = server._server.address().port;
    t.after(() => new Promise(resolve => {
        for (const socket of state.sockets) socket.destroy();
        server.close(resolve);
    }));
    return state;
}

module.exports = { startMysqlFaultServer };

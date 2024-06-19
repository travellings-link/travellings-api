//   _   _      _           _
//  | \ | | ___| | _____   | |    ___   __ _  __ _  ___ _ __
//  |  \| |/ _ \ |/ / _ \  | |   / _ \ / _` |/ _` |/ _ \ '__|
//  | |\  |  __/   < (_) | | |__| (_) | (_| | (_| |  __/ |
//  |_| \_|\___|_|\_\___/  |_____\___/ \__, |\__, |\___|_|
//                                     |___/ |___/
// A Simple Node.JS Logger based on Chalk Module
// Version 1.0.5 | https://github.com/NyaStudio/nekologger
// By BLxcwg666 <huixcwg@gmail.com>
// Start at 2024/02/22 23:10 CST

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const moment = require('moment-timezone');
const dotenv = require('dotenv').config();

function time() {
    return moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
}

const logPath = process.env.LOG_PATH || path.join(__dirname, './../logs');
if (!fs.existsSync(logPath) && process.env.LOG_ENABLE === 'true') {
    fs.mkdirSync(logPath);
}

const logger = {
    enableWrite: process.env.LOG_ENABLE === 'true',
    logStream: null,

    initLogStream: function() {
        if (this.enableWrite) {
            this.logStream = fs.createWriteStream(path.join(logPath, `${moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH-mm-ss')}.log`), { flags: 'a' });
        }
    },

    info: function (msg, who) {
        const log = `[${time()}] [${who}] [INFO] ${msg}`;
        console.log(chalk.blue(log));
        if (this.enableWrite) {
            this.logStream.write('\n' + log);
        }
    },

    ok: function (msg, who) {
        const log = `[${time()}] [${who}] [OK] ${msg}`;
        console.log(chalk.green(log));
        if (this.enableWrite) {
            this.logStream.write('\n' + log);
        }
    },

    warn: function (msg, who) {
        const log = `[${time()}] [${who}] [WARN] ${msg}`;
        console.log(chalk.yellow(log));
        if (this.enableWrite) {
            this.logStream.write('\n' + log);
        }
    },

    err: function (msg, who) {
        const log = `[${time()}] [${who}] [ERROR] ${msg}`;
        console.log(chalk.red(log));
        if (this.enableWrite) {
            this.logStream.write('\n' + log);
        }
    },

    ing: function (msg, who) {
        const log = `[${time()}] [${who}] [INFO] ${msg}`;
        console.log(chalk.cyan(log));
        if (this.enableWrite) {
            this.logStream.write('\n' + log);
        }
    }
};

logger.initLogStream();

module.exports = logger;
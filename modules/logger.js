//   _   _      _           _
//  | \ | | ___| | _____   | |    ___   __ _  __ _  ___ _ __
//  |  \| |/ _ \ |/ / _ \  | |   / _ \ / _` |/ _` |/ _ \ '__|
//  | |\  |  __/   < (_) | | |__| (_) | (_| | (_| |  __/ |
//  |_| \_|\___|_|\_\___/  |_____\___/ \__, |\__, |\___|_|
//                                     |___/ |___/
// A Simple Node.JS Logger based on Chalk Module
// By BLxcwg666 <huixcwg@gmail.com>
// Start at 2024/02/22 23:10 CST

const chalk = require('chalk');
const moment = require('moment-timezone');

function time() {
    return moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
}

const logger = {
    info: function (msg, who) {
        console.log(chalk.blue(`[${time()}] [${who}] [INFO] ${msg}`))
    },

    ok: function (msg, who) {
        console.log(chalk.green(`[${time()}] [${who}] [OK] ${msg}`))
    },

    warn: function (msg, who) {
        console.log(chalk.yellow(`[${time()}] [${who}] [WARN] ${msg}`))
    },

    err: function (msg, who) {
        console.log(chalk.red(`[${time()}] [${who}] [ERROR] ${msg}`))
    },

    ing: function (msg, who) {
        console.log(chalk.cyan(`[${time()}] [${who}] [INFO] ${msg}`))
    }
}

module.exports = logger;
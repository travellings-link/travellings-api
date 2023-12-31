// _____                    _ _ _                         _    ____ ___ 
// |_   _| __ __ ___   _____| | (_)_ __   __ _ ___        / \  |  _ \_ _|
//   | || '__/ _` \ \ / / _ \ | | | '_ \ / _` / __|_____ / _ \ | |_) | | 
//   | || | | (_| |\ V /  __/ | | | | | | (_| \__ \_____/ ___ \|  __/| | 
//   |_||_|  \__,_| \_/ \___|_|_|_|_| |_|\__, |___/    /_/   \_\_|  |___|
//                                       |___/                           
//
// By BLxcwg666 <huixcwg@gmail.com>

const chalk = require('chalk');
const figlet = require('figlet');
const express = require('express');
const moment = require('moment-timezone');
const sql = require('./modules/sqlConfig');
const compression = require('compression');
const routes = require('./modules/router');

const app = express();
const host = process.env.API_HOST;
const port = process.env.API_PORT;

global.version = "2.2";
global.time = function() {
    return moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
}

app.use(compression());
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('X-Powered-By', 'Travellings Project');
    next();
  });
app.use('/', routes);

app.listen(port, host, async () => {
    await figlet("Travellings API", function(err, data) {
        console.log(data);
        console.log(`\nCopyright © 2020－2023 Travellings Project. All rights reserved.（v${global.version}）\n`)
    });
    console.log(chalk.cyan(`[${global.time()}] [INFO] API Started at port ${port} on ${host}`));
});

sql.sync().catch(err => console.log(chalk.red(`[${global.time()}] [ERROR]`, err)));  // 数据库同步 + 错误处理

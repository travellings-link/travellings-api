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
const cookieParser = require('cookie-parser');

const app = express();
const host = process.env.API_HOST;
const port = process.env.API_PORT;

global.version = "5.1";
global.time = function() {
    return moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
}

app.use(compression());
app.use(express.json());
app.use(cookieParser());
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin.match(/^https?:\/\/([a-zA-Z0-9-]+\.)*travellings\.cn$/)) {
        res.header('Access-Control-Allow-Origin', origin);
    }

    res.header('Cache-Control', 'no-store');
    res.header('X-Powered-By', 'Travellings Project');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Content-Type');    
    next();
  });
app.use('/', routes);

app.listen(port, host, async () => {
    await figlet("Travellings API", function(err, data) {
        console.log(data);
        console.log(`\nCopyright © 2020－2024 Travellings Project. All rights reserved.（v${global.version}）\n`)
    });
    console.log(chalk.cyan(`[${global.time()}] [INFO] 尝试连接到数据库...`))
    await sql.sync().then(console.log(chalk.green(`[${global.time()}] [OK] 成功连接到数据库~ `))).catch(err => console.log(chalk.red(`[${global.time()}] [ERROR]`, err)));  // 数据库同步 + 错误处理
    console.log(chalk.cyan(`[${global.time()}] [INFO] API Started at port ${port} on ${host}`));
});

// _____                    _ _ _                         _    ____ ___ 
// |_   _| __ __ ___   _____| | (_)_ __   __ _ ___        / \  |  _ \_ _|
//   | || '__/ _` \ \ / / _ \ | | | '_ \ / _` / __|_____ / _ \ | |_) | | 
//   | || | | (_| |\ V /  __/ | | | | | | (_| \__ \_____/ ___ \|  __/| | 
//   |_||_|  \__,_| \_/ \___|_|_|_|_| |_|\__, |___/    /_/   \_\_|  |___|
//                                       |___/                           
//
// By BLxcwg666 <huixcwg@gmail.com>

const express = require('express');
const cluster = require('cluster');
const config = require('./config');
const log = require('./modules/logger');
const moment = require('moment-timezone');
const routes = require('./modules/router');
const sql = require('./modules/sqlConfig');
const compression = require('compression');
const numCPUs = require('os').cpus().length;
const cookieParser = require('cookie-parser');
const redisClient = require('./modules/redisClient');

const host = config.API_HOST;
const port = config.API_PORT;

global.version = "5.4";
global.time = function () {
    return moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
}

if (cluster.isPrimary) {
    // 主进程中检查数据库
    log.info("尝试连接到数据库...", "APP")
    sql.sync()
        .then(() => {
            log.ok("成功连接到数据库~", "APP")
            // 复制线程
            for (let i = 0; i < numCPUs; i++) {
                cluster.fork();
            }

            // 启动 API
            const app = express();

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

            app.use(function (req, res, next) {  // 把 redis 对象交给其他路由
                req.redisClient = redisClient;
                next();
            });
        
            app.use('/', routes);
            app.listen(port, host, async () => {
                log.info(`API Started at port ${port} on ${host}`, "APP")
            });

        })
        .catch(err => log.err(err, "APP"));  // 数据库同步 + 错误处理

    cluster.on('exit', (worker, code, signal) => {
        log.warn(`线程 PID ${worker.process.pid} 已退出，代码：${code}`, "APP")
        log.info(`尝试启动新线程`, "APP")
        cluster.fork(); // 重新启动子进程
    });
}
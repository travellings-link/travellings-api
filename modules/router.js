// ____             _            
// |  _ \ ___  _   _| |_ ___ _ __ 
// | |_) / _ \| | | | __/ _ \ '__|
// |  _ < (_) | |_| | ||  __/ |   
// |_| \_\___/ \__,_|\__\___|_|   
//         
// By BLxcwg666 <huixcwg@gmail.com>

const chalk = require("chalk");
const sql = require('./sqlConfig');
const express = require("express");
const dotenv = require("dotenv").config();

const router = express.Router();

// index 路由
router.all('/', (req, res) => {
  res.status(200).json({ success: true, msg: "Travellings API Running Nya~", version: version, time: `${global.time()} UTC` });
});

router.use('/random', require('../routes/random'));  // random 路由

// 未匹配的路由
router.use((req, res) => {
  res.status(404).json({ success: false, msg: "你在找什么喵？" });
});

// 错误处理
router.use((err, req, res, next) => {
  console.log(chalk.red(`[${global.time()}] [ERROR]`, err));
  res.status(500).json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
});

sql.sync().catch(err => console.log(chalk.red(`[${global.time()}] [ERROR]`, err)));  // 数据库错误
module.exports = router;

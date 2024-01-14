// ____             _            
// |  _ \ ___  _   _| |_ ___ _ __ 
// | |_) / _ \| | | | __/ _ \ '__|
// |  _ < (_) | |_| | ||  __/ |   
// |_| \_\___/ \__,_|\__\___|_|   
//         
// By BLxcwg666 <huixcwg@gmail.com>

const chalk = require("chalk");
const express = require("express");
const dotenv = require("dotenv").config();

const router = express.Router();

// index 路由
router.all('/', (req, res) => {
  res.status(200).json({ success: true, msg: "你在看什么 ٩(๑`^´๑)۶~", version: version, time: `${global.time()} CST` });
});

// 公共路由
router.use('/all', require('../routes/public/all'));  // 所有站点
router.use('/random', require('../routes/public/random'));  // 随机站点

// 私有路由
router.use('/user', require('../routes/private/user'));  // 用户信息
router.use('/login', require('../routes/private/login'));  // 登录
router.use('/logout', require('../routes/private/logout'));  // 登出
router.use('/action', require('../routes/private/action'));  // 操作

// 未匹配的路由
router.use((req, res) => {
  res.status(404).json({ success: false, msg: "你在找什么喵？" });
});

// 错误处理
router.use((err, req, res, next) => {
  console.log(chalk.red(`[${global.time()}] [ERROR]`, err));
  res.status(500).json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
});

module.exports = router;

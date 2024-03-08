//     _        _   _             
//    / \   ___| |_(_) ___  _ __  
//   / _ \ / __| __| |/ _ \| '_ \ 
//  / ___ \ (__| |_| | (_) | | | |
// /_/   \_\___|\__|_|\___/|_| |_|
//
// By BLxcwg666 <huixcwg@gmail.com>

const chalk = require('chalk');
const express = require('express');
const { webModel } = require('../../modules/sqlModel');
const { authenticate } = require('../../modules/authenticate');

const router = express.Router();
router.use(authenticate);  // 鉴权

router.use('/', require('./actions/get'));  // 站点
router.use('/add', require('./actions/add'));  // 添加站点
router.use('/edit', require('./actions/edit'));  // 修改站点
router.use('/del', require('./actions/del'));  // 删除站点

module.exports = router;

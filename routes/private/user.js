//             _   _   _               
//   __ _  ___| |_| | | |___  ___ _ __ 
//  / _` |/ _ \ __| | | / __|/ _ \ '__|
// | (_| |  __/ |_| |_| \__ \  __/ |   
//  \__, |\___|\__|\___/|___/\___|_|   
//   |___/                              
//
// By BLxcwg666 <huixcwg@gmail.com>

const chalk = require('chalk');
const base32 = require('base32');
const express = require('express');
const { userModel } = require('../../modules/sqlModel');

const router = express.Router();

router.get('/', async (req, res) => {
    if (!req.query.token) {
        res.status(200).json({ success: true, msg: "未登录用户", data: { id: null, user: null, role: 2 } })
    } else {
        const userToken = base32.decode(req.query.token);
        const userInfo = await userModel.findOne({ attributes: ['id', 'user', 'role'], where: { token: userToken } });
        if (!userInfo) {
            res.status(200).json({ success: true, msg: "Token 无效或已过期", data: { id: null, user: null, role: 2 } });
        } else {
            res.status(200).json({ success: true, msg: "用户已登录", data: userInfo });
        }
    }
})
;
module.exports = router;
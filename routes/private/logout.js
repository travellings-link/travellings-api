//  _                            _   
// | |    ___   __ _  ___  _   _| |_ 
// | |   / _ \ / _` |/ _ \| | | | __|
// | |__| (_) | (_| | (_) | |_| | |_ 
// |_____\___/ \__, |\___/ \__,_|\__|
//             |___/                 
//
// By BLxcwg666 <huixcwg@gmail.com>

const chalk = require('chalk');
const base32 = require('base32');
const express = require('express');
const { userModel } = require('../../modules/sqlModel');

const router = express.Router();
function randomString(length) {
    const characters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let randomString = '';
  
    for (let i = 0; i < length; i++) {
      const randomIndex = Math.floor(Math.random() * characters.length);
      randomString += characters.charAt(randomIndex);
    }
  
    return randomString;
}

router.get('/', async (req, res) => {

    if (!req.cookies._tlogin) {
        res.status(400).json({ success: false, msg: "你都没登录呢你注销什么 ヽ(‘⌒´メ)ノ" })
    } else {
        const userToken = base32.decode(req.cookies._tlogin);
        const user = await userModel.findOne({
            where: {
              token: userToken,
            },
        });

        if (!user) {
            return res.status(401).json({ success: false, msg: "Token 无效或已过期 ┐(´-｀)┌" });
         }
     
         const findToken = { where: { token: userToken } };
         const updateToken = { token: Buffer.from(randomString(45)).toString('base64') };
     
         userModel.update(updateToken, findToken)
         .then((result) => {
             res.clearCookie('_tlogin');
             res.status(200).json({ success: true, msg: "注销成功！" });
         })
         .catch((error) => {
             console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
             res.status(500).json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });    
         });
    }
});

module.exports = router;
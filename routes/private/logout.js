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

    if (!req.query.token) {
        return res.json({ success: false, msg: "你都没带 Token 你跑来注销什么 ヽ(‘⌒´メ)ノ" })
    }

    const userToken = base32.decode(req.query.token);
    const user = await userModel.findOne({
        where: {
          token: userToken,
        },
    });

    if (!user) {
        return res.json({ success: false, msg: "Token 无效或已过期 ┐(´-｀)┌" });
     }
 
     const findToken = { where: { token: userToken } };
     const updateToken = { token: Buffer.from(randomString(45)).toString('base64') };
 
     userModel.update(updateToken, findToken)
     .then((result) => {
        // res.clearCookie('_tlogin');
        res.json({ success: true, msg: "注销成功！" });
     })
     .catch((error) => {
        console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
        res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });    
     });
});

module.exports = router;
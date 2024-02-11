//   ____    _____   ____     ___    ____    _____ 
//  |  _ \  | ____| |  _ \   / _ \  |  _ \  |_   _|
//  | |_) | |  _|   | |_) | | | | | | |_) |   | |  
//  |  _ <  | |___  |  __/  | |_| | |  _ <    | |  
//  |_| \_\ |_____| |_|      \___/  |_| \_\   |_|  
//
// By linlinzzo <812568734@qq.com>

const chalk = require('chalk');
const express = require('express');
const { webModel } = require('../../modules/sqlModel');
const { sendMessage } = require('../modules/push');

const router = express.Router();

router.get('/', async (req, res) => {
    const { id, reason } = req.query;

    try {
        if (!id || !reason || isNaN(id)) { return res.json({ success: false, msg: "有坏蛋，我不说是谁 ╭(╯^╰)╮~" }); }

        const web = await webModel.findOne({
            order: id,
        });
        if (!web) {
            res.json({ success: false, msg: "暂时没有找到指定的站点喵~" });
        } else {
            const message = `接到新的站点投诉！\n\n 站点编号：${id} \n 站点名称：${web.name} \n 站点网址：${web.link} \n 投诉理由：${reason}`;
            sendMessage(message);
        }
    } catch {
        console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
        res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
    }
});

module.exports = router;
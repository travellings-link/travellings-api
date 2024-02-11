//   ____    _____   ____     ___    ____    _____ 
//  |  _ \  | ____| |  _ \   / _ \  |  _ \  |_   _|
//  | |_) | |  _|   | |_) | | | | | | |_) |   | |  
//  |  _ <  | |___  |  __/  | |_| | |  _ <    | |  
//  |_| \_\ |_____| |_|      \___/  |_| \_\   |_|  
//
// By linlinzzo <812568734@qq.com>

const chalk = require('chalk');
const { sendMessage } = require('../../modules/push');
const express = require('express');
const { webModel } = require('../../modules/sqlModel');

const router = express.Router();

router.post('/', async (req, res) => {
    const { id, reason, vk } = req.body;
    const ip = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;
    const ua = req.headers['user-agent'];

    if (vk) {
        let formData = new FormData();
        formData.append('secret', process.env.CF_SECRET_KEY);
        formData.append('response', vk);
        formData.append('remoteip', ip);

        const url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
        const result = await fetch(url, {
            body: formData,
            method: 'POST',
        });

        const outcome = await result.json();
        if (outcome.success) {
            try {
                if (!id || !reason || isNaN(id)) { return res.json({ success: false, msg: "有坏蛋，我不说是谁 ╭(╯^╰)╮~" }); }

                const web = await webModel.findByPk(id);

                if (!web) {
                    res.json({ success: false, msg: "没有找到指定的站点喵~" });
                } else {
                    await sendMessage(`<strong>接到新的站点投诉！</strong>\n\n 站点编号：${id} \n 站点名称：${web.name} \n 站点网址：${web.link} \n 投诉理由：${reason}\n\nIP：${ip}\nUser-Agent：${ua}`);
                    console.log(chalk.cyan(`[${global.time()}] [INFO] Received Report: ${ip} reported ${id}`));
                    res.json({ success: true, msg: "举报成功，感谢您的贡献（ '▿ ' ）"})
                }

            } catch (error){
                console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
                res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
            }
        } else {
            res.json({ success: false, msg: "验证失败"})
        }
    } else {
        res.json({ success: false, msg: "验证失败"})
    }
});

module.exports = router;
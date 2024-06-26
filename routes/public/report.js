//   ____    _____   ____     ___    ____    _____ 
//  |  _ \  | ____| |  _ \   / _ \  |  _ \  |_   _|
//  | |_) | |  _|   | |_) | | | | | | |_) |   | |  
//  |  _ <  | |___  |  __/  | |_| | |  _ <    | |  
//  |_| \_\ |_____| |_|      \___/  |_| \_\   |_|  
//
// By linlinzzo <812568734@qq.com>

const axios = require('axios');
const https = require("https");
const express = require('express');
const log = require('../../modules/logger');
const { sendMessage } = require('../../modules/push');
const { webModel } = require('../../modules/sqlModel');

const router = express.Router();

// router.post('/', async (req, res) => {
//     const { id, reason, vk } = req.body;
//     const ip = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;
//     const ua = req.headers['user-agent'];

//     if (vk) {
//         const url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
//         const config = {
//             method: 'post',
//             timeout: 30000,
//             httpsAgent: new https.Agent({ keepAlive: true }),
//             url: url,
//             headers: {
//                 'Content-Type': 'application/json',
//             },
//             data: { secret: process.env.CF_SECRET_KEY, response: vk, remoteip: ip },
//         };

//         try {
//             const response = await axios(config);

//             if (response.data.success) {
//                 if (!id || !reason || isNaN(id)) {
//                     return res.json({ success: false, msg: "有坏蛋，我不说是谁 ╭(╯^╰)╮~" });
//                 }

//                 const web = await webModel.findByPk(id);

//                 if (!web) {
//                     res.json({ success: false, msg: "没有找到指定的站点喵~" });
//                 } else {
//                     await sendMessage(`<strong>接到新的站点投诉！</strong>\n\n 站点编号：${id} \n 站点名称：${web.name} \n 站点网址：${web.link} \n 投诉理由：${reason}\n\n<strong>IP：</strong>${ip}\n<strong>User-Agent：</strong>${ua}`);
//                     console.log(chalk.cyan(`[${global.time()}] [INFO] Received Report: ${ip} reported ${id}`));
//                     res.json({ success: true, msg: "举报成功，感谢您的贡献（ '▿ ' ）"})
//                 }
//             } else {
//                 res.json({ success: false, msg: "验证失败" });
//             }
//         } catch (error) {
//             log.err(error, "REPORT");
//             res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
//         }
//     } else {
//         res.json({ success: false, msg: "验证失败" });
//     }
// });

router.post('/', async (req, res) => {
    const { id, reason, vk } = req.body;
    const ip = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;
    const ua = req.headers['user-agent'];

    try {
        if (!id || !reason || isNaN(id)) {
            return res.json({ success: false, msg: "有坏蛋，我不说是谁 ╭(╯^╰)╮~" });
        }

        const web = await webModel.findByPk(id);

        if (!web) {
            res.json({ success: false, msg: "没有找到指定的站点喵~" });
        } else {
            await sendMessage(`<strong>接到新的站点投诉！</strong>\n\n 站点编号：${id} \n 站点名称：${web.name} \n 站点网址：${web.link} \n 投诉理由：${reason}\n\n<strong>IP：</strong>${ip}\n<strong>User-Agent：</strong>${ua}`);
            log.info(`Received Report: ${ip} reported ${id}`, "REPORT");
            res.json({ success: true, msg: "举报成功，感谢您的贡献（ '▿ ' ）"})
        }
    } catch (error) {
        log.err(error, "REPORT");
        res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
    }
});

module.exports = router;
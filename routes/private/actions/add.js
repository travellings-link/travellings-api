const express = require('express');
const log = require('../../../modules/logger');
const { webModel } = require('../../../modules/sqlModel');
const closeIssues = require('../../../utils/closeIssues');
const redisClient = require('../../../modules/redisClient');

const router = express.Router();

router.post('/', async (req, res) => {
    const webData = req.body;
    const ip = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;

    if (!webData || !Array.isArray(webData) || webData.length === 0) {
        return res.json({ success: false, msg: "每个 data 中都应该告诉我名称（name）和链接（link）吧 ٩(๑`^´๑)۶" });
    }

    try {
        let dupLinks = [];
        const newWebs = await Promise.all(webData.map(async ({ name, link, tag = 'go', status = 'RUN', issuesId }) => {
            if (!name || !link) {
                // 跳过无效的 data
                log.warn(`Received invalid webData: ${JSON.stringify({ name, link})} from ${ip}`, "ACTION")
                return null;
            }

            // 查重
            const existWeb = await webModel.findOne({ where: { link } });

            if (existWeb) {
                log.warn(`Received duplicate link: ${link} from ${ip}`, "ACTION")
                dupLinks.push({ id: existWeb.id, link });
                return null;
            }

            let newWeb = await webModel.create({ name, link, tag, status });

            // 顺手关了 issues
            if (issuesId) {
                closeIssues(issuesId)
                    .catch(error => {
                        log.warn(error, "ACTION")
                    });
            }

            return newWeb;
        }));

        if (dupLinks.length > 0) {
            return res.json({ success: false, msg: "请求中有些链接已经在数据库中了 ٩(๑`^´๑)۶", data: dupLinks });
        }

        const validWebs = newWebs.filter(web => web !== null);

        if (validWebs.length > 0) {
            // 清除缓存
            const cacheKey = 'data:all';
            redisClient.del(cacheKey);
            // 返回结果
            res.json({ success: true, msg: "添加好啦 ´･ᴗ･`", data: validWebs });
        } else {
            res.json({ success: false, msg: "每个 data 中都应该告诉我名称（name）和链接（link）吧 ٩(๑`^´๑)۶" });
        }
    } catch (error) {
        log.err(error, "ACTION")
        res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
    }
});

module.exports = router;
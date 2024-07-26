//     _    _     _     
//    / \  | |   | |    
//   / _ \ | |   | |    
//  / ___ \| |___| |___ 
// /_/   \_\_____|_____|
//
// By BLxcwg666 <huixcwg@gmail.com>

const express = require('express');
const { Op } = require("sequelize");
const log = require('../../modules/logger');
const { rssModel } = require('../../modules/sqlModel');
const redisClient = require('../../modules/redisClient');

const router = express.Router();

// 连接到 Redis
redisClient.connect();

router.get('/', async (req, res) => {
    const { tag } = req.query;
    const cacheKey = `rss:${tag || 'all'}`;

    try {
        const cachedData = await redisClient.get(cacheKey);

        if (cachedData) {
            // 找见了就直接返回
            // console.log('found data from redis');
            res.json({ success: true, total: JSON.parse(cachedData).length, data: JSON.parse(cachedData) });
        } else {
            // 没有就返回数据库中的
            // console.log('not found data from redis');
            getDataFromDB(req, res, cacheKey, tag);
        }
    } catch (error) {
        log.err(error, "RSS");
        res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
    }
});

async function getDataFromDB(req, res, cacheKey, tag) {
    let queryData = {};

    if (tag) {
        queryData.tag = {
            [Op.like]: `%${tag}%`
        };
    }

    const queryOptions = { where: queryData };

    const { rows } = await rssModel.findAndCountAll(queryOptions);

    const data = rows.map(rss => ({
        id: rss.id,
        name: rss.name,
        content: rss.status,
        lastGot: rss.link,
        originLink: rss.tag,
        rssLink: rss.failedReason,
        tag: rss.tag
    }));

    // 写入 redis
    redisClient.setEx(cacheKey, 114514, JSON.stringify(data));
    res.json({ success: true, total: data.length, data: data });
}

module.exports = router;
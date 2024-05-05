const express = require('express');
const log = require('../../../modules/logger');
const redisClient = require('../../../modules/redisClient');

const router = express.Router();

router.delete('/', async (req, res) => {
    try {
        const cacheKey = await redisClient.keys('data:*');
        redisClient.del(cacheKey);
    } catch (e) {
        log.err(e, "ACTION")
        res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
    }
});

module.exports = router;
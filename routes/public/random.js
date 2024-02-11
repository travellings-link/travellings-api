// ____                 _
// |  _ \ __ _ _ __   __| | ___  _ __ ___
// | |_) / _` | '_ \ / _` |/ _ \| '_ ` _ \
// |  _ < (_| | | | | (_| | (_) | | | | | |
// |_| \_\__,_|_| |_|\__,_|\___/|_| |_| |_|
//
// By BLxcwg666 <huixcwg@gmail.com>

const chalk = require('chalk');
const express = require("express");
const { Sequelize, Op } = require('sequelize');
const { webModel } = require('../../modules/sqlModel');

const router = express.Router();

router.get('/', async (req, res) => {
    try {
        let web;
        const tag = req.query.tag;

        if (!tag) {
            web = await webModel.findOne({
                where: { status: 'RUN' },
                order: Sequelize.literal('RAND()'),
            });
        } else {
            web = await webModel.findOne({
                where: {
                    tag: {
                        [Op.like]: `%${tag}%`
                    }
                },
                order: Sequelize.literal('RAND()'),
            });
        }

        if (!web) {
            res.json({ success: false, msg: "暂时没有状态为 RUN 且该查询条件的站点喵~" });
        } else {
            res.json({ success: true, data: [{ id: web.id, name: web.name, url: web.link, tag: web.tag }]});
        }
    } catch (error) {
        console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
        res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
    }
});

module.exports = router;
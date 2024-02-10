// ____                 _                 
// |  _ \ __ _ _ __   __| | ___  _ __ ___  
// | |_) / _` | '_ \ / _` |/ _ \| '_ ` _ \ 
// |  _ < (_| | | | | (_| | (_) | | | | | |
// |_| \_\__,_|_| |_|\__,_|\___/|_| |_| |_|
//
// By BLxcwg666 <huixcwg@gmail.com>

const chalk = require('chalk');
const express = require("express");
const { Sequelize } = require('sequelize');
const { webModel } = require('../../modules/sqlModel');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const queryData = { status: 'RUN' };
    const queryTag = req.query;
    if (queryTag) {queryData.tag = queryTag.toUpperCase()}
    const web = await webModel.findOne({
      where: queryData,
      order: Sequelize.literal('RAND()'),
    });

    if (!web) {
      res.json({ success: false, msg: "暂时没有状态为 RUN 的站点喵~" });
    } else {
      res.json({ success: true, data: [{ id: web.id, name: web.name, url: web.link, tag: web.tag }]});
    }
  } catch (error) {
    console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
    res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
  }
});

module.exports = router;

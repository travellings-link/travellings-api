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
const Web = require('../modules/sqlModel');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const web = await Web.findOne({
      where: { status: 'RUN' },
      order: Sequelize.literal('RAND()'),
    });

    if (!web) {
      res.status(404).json({ success: false, msg: "暂时没有状态为 RUN 的站点喵~" });
    } else {
      res.status(200).json({ success: true, data: [{ id: web.indexs, name: web.name, url: web.link, tag: web.tag }]});
    }
  } catch (error) {
    console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
    res.status(500).json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
  }
});

module.exports = router;
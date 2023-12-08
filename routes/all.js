const chalk = require('chalk');
const express = require('express');
const { Op } = require('sequelize');
const Web = require('../modules/sqlModel');

const router = express.Router();

router.get('/', async (req, res) => {
  const { status } = req.query;

  try {
    let queryData = {};

    if (status) {
      queryData.status = status.toUpperCase();
    }

    const webs = await Web.findAll({
      where: queryData,
    });

    const data = webs.map(web => ({
      id: web.indexs,
      name: web.name,
      url: web.link,
      status: web.status,
      tag: web.tag,
    }));

    res.status(200).json({ status: true, data: data });
  } catch (error) {
    console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
    res.status(500).json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
  }
});

module.exports = router;

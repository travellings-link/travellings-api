//     _        _   _             
//    / \   ___| |_(_) ___  _ __  
//   / _ \ / __| __| |/ _ \| '_ \ 
//  / ___ \ (__| |_| | (_) | | | |
// /_/   \_\___|\__|_|\___/|_| |_|
//
// By BLxcwg666 <huixcwg@gmail.com>

const chalk = require('chalk');
const express = require('express');
const Web = require('../modules/sqlModel');

const router = express.Router();

// 暂时没想好放啥，就先放个 400
router.get('/', async (req, res) => {
    return res.status(400).json({ success: false, msg: "有坏蛋，我不说是谁 ╭(╯^╰)╮~" });
});

// 添加站点
router.post('/', async (req, res) => {
  const { name, link, tag = 'go', status = 'WAIT' } = req.body;

  if (!name || !link) {
    return res.status(400).json({ success: false, msg: "至少应该告诉我名称（name）和链接（link）吧 ヽ(‘⌒´メ)ノ" });
  }

  try {
    const newWeb = await Web.create({ name, link, tag, status });
    res.json({ success: true, msg: "添加好啦 ´･ᴗ･`", data: newWeb });
  } catch (error) {
    console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
    res.status(500).json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
  }
});

// 更新站点
router.put('/', async (req, res) => {
    const { id, name, link, tag, status } = req.body;
  
    if (!id) {
      return res.status(400).json({ success: false, msg: "至少应该告诉我编号（id）吧 ヽ(‘⌒´メ)ノ" });
    }
  
    try {
      const web = await Web.findByPk(id);
      if (web) {
        const oldWeb = { ...web.get() }; // 复制更新前的数据
  
        if (name) web.name = name;
        if (link) web.link = link;
        if (tag) web.tag = tag;
        if (status) web.status = status;
  
        await web.save();
  
        const updatedWeb = web.get(); // 获取更新后的数据
  
        res.json({ success: true, msg: "修改完成 ´･ᴗ･`", data: { oldWeb, updatedWeb } });
      } else {
        res.status(404).json({ success: false, msg: "没找到这个站点 -_-#" });
      }
    } catch (error) {
        console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
        res.status(500).json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
    }
  });
  

// 删除站点
router.delete('/', async (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ success: false, msg: "至少应该告诉我编号（id）吧 ヽ(‘⌒´メ)ノ" });
  }

  try {
    const web = await Web.findByPk(id);
    if (web) {
      await web.destroy();
      res.json({ success: true, msg: "删掉啦 ´･ᴗ･`" });
    } else {
      res.status(404).json({ success: false, msg: "没找到这个站点 -_-#" });
    }
  } catch (error) {
    console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
    res.status(500).json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
  }
});

module.exports = router;

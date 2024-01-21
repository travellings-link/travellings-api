//     _        _   _             
//    / \   ___| |_(_) ___  _ __  
//   / _ \ / __| __| |/ _ \| '_ \ 
//  / ___ \ (__| |_| | (_) | | | |
// /_/   \_\___|\__|_|\___/|_| |_|
//
// By BLxcwg666 <huixcwg@gmail.com>

const chalk = require('chalk');
const express = require('express');
const { webModel } = require('../../modules/sqlModel');
const { authenticate } = require('../../modules/authenticate');

const router = express.Router();
router.use(authenticate);  // 鉴权
function isInt(str) {
  return /^\d+$/.test(str);
}


router.get('/:id', async (req, res) => {
    if (!isInt(req.params.id) || !req.params.id) {
      return res.json({ success: false, msg: "有坏蛋，我不说是谁 ╭(╯^╰)╮~" });
    }

    const web = await webModel.findByPk(req.params.id);
    res.json({ success: true, data: { id: web.id, name: web.name, link: web.link, status: web.status, tag: web.tag } });
});

// 添加站点
router.post('/add', async (req, res) => {
  const webData = req.body;
  const ip = req.headers['x-forwarded-for'] || req.ip;

  if (!webData || !Array.isArray(webData) || webData.length === 0) {
    return res.json({ success: false, msg: "每个 data 中都应该告诉我名称（name）和链接（link）吧 ٩(๑`^´๑)۶" });
  }

  try {
    let dupLinks = [];
    const newWebs = await Promise.all(webData.map(async ({ name, link, tag = 'go', status = 'WAIT' }) => {
      if (!name || !link) {
        // 跳过无效的 data
        console.log(chalk.yellow(`[${global.time()}] [WARNING] Received invalid webData: ${JSON.stringify({ name, link})} from ${ip}`));
        return null;
      }

      // 查重
      const existWeb = await webModel.findOne({ where: { link } });

      if (existWeb) {
        console.log(chalk.yellow(`[${global.time()}] [WARNING] Received duplicate link: ${link}`));
        dupLinks.push({ id: existWeb.id, link });
        return null;
      }

      return await webModel.create({ name, link, tag, status });
    }));

    if (dupLinks.length > 0) {
      return res.json({ success: false, msg: "请求中有些链接已经在数据库中了 ٩(๑`^´๑)۶", data: dupLinks });
    }

    const validWebs = newWebs.filter(web => web !== null);

    if (validWebs.length > 0) {
      res.json({ success: true, msg: "添加好啦 ´･ᴗ･`", data: validWebs });
    } else {
      res.json({ success: false, msg: "每个 data 中都应该告诉我名称（name）和链接（link）吧 ٩(๑`^´๑)۶" });
    }
  } catch (error) {
    console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
    res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
  }
});


// 更新站点
router.post('/edit', async (req, res) => {
    const { id, name, link, tag, status } = req.body;
  
    if (!id) {
      return res.json({ success: false, msg: "至少应该告诉我编号（id）吧 ヽ(‘⌒´メ)ノ" });
    }
  
    try {
      const web = await webModel.findByPk(id);
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
        res.json({ success: false, msg: "没找到这个站点 -_-#" });
      }
    } catch (error) {
        console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
        res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
    }
});
  

// 删除站点
router.post('/del', async (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.json({ success: false, msg: "至少应该告诉我编号（id）吧 ヽ(‘⌒´メ)ノ" });
  }

  try {
    const web = await webModel.findByPk(id);
    if (web) {
      await web.destroy();
      res.json({ success: true, msg: "删掉啦 ´･ᴗ･`" });
    } else {
      res.json({ success: false, msg: "没找到这个站点 -_-#" });
    }
  } catch (error) {
    console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
    res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
  }
});

module.exports = router;

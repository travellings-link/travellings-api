//     _    _     _     
//    / \  | |   | |    
//   / _ \ | |   | |    
//  / ___ \| |___| |___ 
// /_/   \_\_____|_____|
//
// By BLxcwg666 <huixcwg@gmail.com>

const chalk = require('chalk');
const express = require('express');
const Web = require('../modules/sqlModel');

const router = express.Router();

router.get('/', async (req, res) => {
    const { status, limit } = req.query;
  
    try {
        let queryData = {};
        if (status) {queryData.status = status.toUpperCase()};
        const queryOptions = {where: queryData};

        if (limit) {
          const limitValue = parseInt(limit, 10);
          if (isNaN(limitValue)) {
            return res.status(400).json({ success: false, msg: "有坏蛋，我不说是谁 ╭(╯^╰)╮~" });
          }
          queryOptions.limit = limitValue;
        }

        const { count, rows } = await Web.findAndCountAll(queryOptions);
    
        const data = rows.map(web => ({
          id: web.id,
          name: web.name,
          status: web.status,
          url: web.link,
          tag: web.tag,
        }));

        let total = limit ? parseInt(limit, 10) : count;
  
        res.status(200).json({ status: true, total: total, data: data });
    } catch (error) {
        console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
        res.status(500).json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
    }
  });  

module.exports = router;

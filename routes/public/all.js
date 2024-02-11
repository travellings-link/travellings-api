//     _    _     _     
//    / \  | |   | |    
//   / _ \ | |   | |    
//  / ___ \| |___| |___ 
// /_/   \_\_____|_____|
//
// By BLxcwg666 <huixcwg@gmail.com>

const chalk = require('chalk');
const express = require('express');
const { webModel } = require('../../modules/sqlModel');
const {Op} = require("sequelize");

const router = express.Router();

router.get('/', async (req, res) => {
    const { status, tag } = req.query;

    try {
        let queryData = {};
        if (status) {
            queryData.status = status.toUpperCase();
        }

        if (tag) {
            queryData.tag = {
                [Op.like]: `%${tag}%`
            };
        }

        const queryOptions = { where: queryData };

        const { count, rows } = await webModel.findAndCountAll(queryOptions);

        const data = rows.map(web => ({
            id: web.id,
            name: web.name,
            status: web.status,
            url: web.link,
            tag: web.tag,
            failedReason: web.failedReason,
        }));

        res.json({ success: true, total: count, data: data });
    } catch (error) {
        console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
        res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
    }
});

module.exports = router;

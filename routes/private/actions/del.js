const chalk = require('chalk');
const express = require('express');
const { webModel } = require('../../../modules/sqlModel');

const router = express.Router();

router.post('/', async (req, res) => {
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
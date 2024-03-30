const chalk = require('chalk');
const express = require('express');
const { webModel } = require('../../../modules/sqlModel');
const addLabel = require('../../../utils/addLabel');

const router = express.Router();

router.post('/', async (req, res) => {
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

            // 顺手添加 label
            if (issuesId) {
                addLabel(issuesId)
                    .catch(error => {
                        console.log(chalk.yellow(`[${global.time()}] [WARNING]`, error));
                    });
            }

        } else {
            res.json({ success: false, msg: "没找到这个站点 -_-#" });
        }
    } catch (error) {
        console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
        res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
    }
});

module.exports = router;
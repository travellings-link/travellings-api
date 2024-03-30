const express = require('express');
const { webModel } = require('../../../modules/sqlModel');

const router = express.Router();

// 获取
router.get('/:id', async (req, res) => {
    if (isNaN(req.params.id) || !req.params.id) {
        return res.json({ success: false, msg: "有坏蛋，我不说是谁 ╭(╯^╰)╮~" });
    }
    try {
        const web = await webModel.findByPk(req.params.id);
        res.json({ success: true, data: { id: web.id, name: web.name, link: web.link, status: web.status, tag: web.tag } });
    } catch (error) {
        res.json({ success: false, msg: "没找到捏 ╮(￣▽￣)╭"})
    }
});

module.exports = router;
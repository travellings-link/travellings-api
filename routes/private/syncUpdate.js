//  ____                   
// / ___| _   _ _ __   ___ 
// \___ \| | | | '_ \ / __|
//  ___) | |_| | | | | (__ 
// |____/ \__, |_| |_|\___|
//        |___/            
//
// By BLxcwg666 <huixcwg@gmail.com>

const express = require('express');
const dotenv = require("dotenv").config();
const { exec } = require('child_process');
const log = require('../../modules/logger');
const { authenticate } = require('../../modules/authenticate');

const router = express.Router();
router.use(authenticate);  // 鉴权

const repoPaths = {
  www: process.env.WWW_PATH,
  mlist: process.env.MLIST_PATH,
};

router.post('/:repo', (req, res) => {
  const repoName = req.params.repo;
  const repoPath = repoPaths[repoName];
  const ip = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;

  if (!repoPath) {
    return res.json({ success: false, msg: "至少要告诉我同步哪个仓库吧 (-`ェ´-╬)" });
  }

  exec('git pull', { cwd: repoPath }, (error, stdout) => {
    if (error) {
      log.err(`Failed to pull：${error}`, "SYNC");
      log.err(`Output：${stdout}`, "SYNC");
      return res.status(500).json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
    }

    log.ok(`Sync successfully from ${ip}`, "SYNC")
    res.json({ success: true, msg: "同步成功 (*´▽`*)" });
  });
});

module.exports = router;
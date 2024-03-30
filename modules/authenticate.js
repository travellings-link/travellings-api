//     _         _   _                _   _           _       
//    / \  _   _| |_| |__   ___ _ __ | |_(_) ___ __ _| |_ ___ 
//   / _ \| | | | __| '_ \ / _ \ '_ \| __| |/ __/ _` | __/ _ \
//  / ___ \ |_| | |_| | | |  __/ | | | |_| | (_| (_| | ||  __/
// /_/   \_\__,_|\__|_| |_|\___|_| |_|\__|_|\___\__,_|\__\___|
//
// By BLxcwg666 <huixcwg@gmail.com>

const log = require('./logger');
const base32 = require('base32');
const { userModel } = require('../modules/sqlModel');

const authenticate = async (req, res, next) => {
  const ip = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;
  try {
    if (!req.cookies._tlogin) {
      log.warn(`Authorization failed from ${ip}：No Token`, "AUTH")
      return res.json({ success: false, msg: "访问此目录需要 Token ヽ(‘⌒´メ)ノ" })
    }
    
    const userToken = base32.decode(req.cookies._tlogin);
    const user = await userModel.findOne({
      where: {
        token: userToken,
      },
    });

    if (!user) {
      log.warn(`Authorization failed from ${ip}：Invaild Token`, "AUTH");
      return res.json({ success: false, msg: "Token 无效或已过期 ┐(´-｀)┌" });
    }

    if (user.role !== '0') {
      log.warn(`Access Denied from ${ip}：Permissions Denied`, "AUTH")
      return res.json({ success: false, msg: "外来人，拒绝入内！￣へ￣" });
    }

    next();
  } catch (error) {
    log.err(error, "AUTH")
    res.json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
  }
};

module.exports = { authenticate };
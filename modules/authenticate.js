//     _         _   _                _   _           _       
//    / \  _   _| |_| |__   ___ _ __ | |_(_) ___ __ _| |_ ___ 
//   / _ \| | | | __| '_ \ / _ \ '_ \| __| |/ __/ _` | __/ _ \
//  / ___ \ |_| | |_| | | |  __/ | | | |_| | (_| (_| | ||  __/
// /_/   \_\__,_|\__|_| |_|\___|_| |_|\__|_|\___\__,_|\__\___|
//
// By BLxcwg666 <huixcwg@gmail.com>

const base32 = require('base32');
const { userModel } = require('../modules/sqlModel');

const authenticate = async (req, res, next) => {
  try {

    const userToken = base32.decode(req.cookies._tlogin);

    if (!userToken) {
      return res.status(401).json({ success: false, msg: "你还没登录呢 ヽ(‘⌒´メ)ノ" })
    }

    const user = await userModel.findOne({
      where: {
        token: userToken,
      },
    });

    if (!user) {
      return res.status(401).json({ success: false, msg: "Token 无效或已过期 ┐(´-｀)┌" });
    }

    if (user.role !== '0') {
      return res.status(403).json({ success: false, msg: "外来人，拒绝入内！￣へ￣" });
    }

    next();
  } catch (error) {
    console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
    res.status(500).json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
  }
};

module.exports = { authenticate };
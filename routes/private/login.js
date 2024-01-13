// _                _       
// | |    ___   __ _(_)_ __  
// | |   / _ \ / _` | | '_ \ 
// | |__| (_) | (_| | | | | |
// |_____\___/ \__, |_|_| |_|
//             |___/         
//
// By BLxcwg666 <huixcwg@gmail.com>

const axios = require('axios');
const chalk = require('chalk');
const express = require('express');
const dotenv = require('dotenv').config();
const querystring = require('querystring');
const encryptToken = require('../../utils/encrypt');
const { userModel } = require('../../modules/sqlModel');

const router = express.Router();
const clientID = process.env.GH_CLIENTID;
const clientSecret = process.env.GH_CLIENTST;
const redirectURI = process.env.GH_CALLBACK_URL;

router.get('/github', (req, res) => {
  const authURL = 'https://github.com/login/oauth/authorize';
  const params = {
    client_id: clientID,
    redirect_uri: redirectURI,
    scope: 'read:user',
  };
  const authRedirectURL = `${authURL}?${querystring.stringify(params)}`;
  res.redirect(authRedirectURL);
});

router.get('/github/callback', async (req, res) => {
  const tokenURL = 'https://github.com/login/oauth/access_token';
  const { code } = req.query;
  const params = {
    client_id: clientID,
    client_secret: clientSecret,
    code: code,
    redirect_uri: redirectURI,
  };

  try {
    const getData = await axios.post(tokenURL, querystring.stringify(params), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    
    const data = getData.data; 
    const accessToken = querystring.parse(data).access_token;

    // 获取用户信息
    const getUserData = await axios.get('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const userData = getUserData.data;

    // 创建 & 更新
    const user = await userModel.findOrCreate({
        where: { user: userData.login },
        defaults: {
          user: userData.login,
          token: encryptToken(accessToken, process.env.SAFETY_CUSTOM_KEY),
          role: 'Guest',
          lastLogin: global.time(),
        },
      });
      
      const [foundUser, created] = user;
      
      if (!created) {
        await foundUser.update({
          token: encryptToken(accessToken, process.env.SAFETY_CUSTOM_KEY),
          lastLogin: global.time(),
        });
      };

    res.send('Login successful!');
  } catch (error) {
    console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
    res.status(500).json({ success: false, msg: "出错了呜呜呜~ 请检查控制台输出喵~" });
  }
});

module.exports = router;
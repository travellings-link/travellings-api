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
const base32 = require('base32');
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
    const tokenURL = 'https://gh-proxy.nyakori.tech/login/oauth/access_token';
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
          'User-Agent': req.headers['user-agent'],
        },
      });
      
      const data = getData.data; 
      const accessToken = querystring.parse(data).access_token;
  
      // 获取用户信息
      const getUserData = await axios.get('https://gh-api.nyakori.tech/user', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': req.headers['user-agent'],
        },
      });
  
      const userData = getUserData.data;
  
      // 创建 & 更新
      const token = encryptToken(code, process.env.SAFETY_CUSTOM_KEY);
      const cookie = base32.encode(token);

      const user = await userModel.findOrCreate({
          where: { user: userData.login },
          defaults: {
            user: userData.login,
            token: token,
            role: '1',
            lastLogin: global.time(),
          },
        });
        
        const [foundUser, created] = user;
        
        if (!created) {
          await foundUser.update({
            token: token,
            lastLogin: global.time(),
          });
        };
        // res.json({ success: true, msg: "登录成功", data: { user: userData.login, token: cookie}})
      res.cookie('_tlogin', cookie, {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        domain: '.travellings.cn'
      });

      res.redirect(`https://list.travellings.cn/`);
    } catch (error) {
      console.log(chalk.red(`[${global.time()}] [ERROR]`, error));
      res.json({ success: false, msg: "登录失败", error: error.message });
    }
});

module.exports = router;
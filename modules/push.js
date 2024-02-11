//  _____    _                                  ____            _     
// |_   _|__| | ___  __ _ _ __ __ _ _ __ ___   |  _ \ _   _ ___| |__  
//   | |/ _ \ |/ _ \/ _` | '__/ _` | '_ ` _ \  | |_) | | | / __| '_ \ 
//   | |  __/ |  __/ (_| | | | (_| | | | | | | |  __/| |_| \__ \ | | |
//   |_|\___|_|\___|\__, |_|  \__,_|_| |_| |_| |_|    \__,_|___/_| |_|
//                  |___/                                             
//
// Telegram Notify Push Util
// By BLxcwg666 <huixcwg@gmail.com>
// 2024/01/16 04:38 CST

const chalk = require('chalk');
const { Telegraf } = require('telegraf');
const dotenv = require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN, { telegram: { apiRoot: process.env.BOT_API } });

async function sendMessage(message) {
  try {
    await bot.telegram.sendMessage(process.env.BOT_CHATID, message, { parse_mode: 'HTML' });
  } catch (error) {
    console.log(chalk.red(`[${global.time()}] [TBOT] [ERROR]`, error))
  }
}

module.exports = { sendMessage };
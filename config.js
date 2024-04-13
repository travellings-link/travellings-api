// 别动这个

if (!process.env.LOADED_CONFIG) {
    require('dotenv').config(); // 加载 .env 文件中的环境变量
    process.env.LOADED_CONFIG = true; // 标记 dotenv 已加载
}

const config = {
    // API
    API_PORT: process.env.API_PORT || 3000,
    API_HOST: process.env.API_HOST || '0.0.0.0',

    // Github Auth
    GH_PRIVATE_KEY: process.env.GH_PRIVATE_KEY || './data/privateKey.pem',

    // TG Bot
    BOT_API: process.env.BOT_API || 'https://tgapi.nyakori.tech',
    BOT_CHATID: process.env.BOT_CHATID || 5502448506,

    // Redis
    REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
    REDIS_PORT: process.env.REDIS_PORT || 6379
};

module.exports = config;
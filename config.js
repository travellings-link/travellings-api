// 别动这个

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
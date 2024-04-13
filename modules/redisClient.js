const redis = require('redis');
const config = require('../config');

const redisClient = redis.createClient({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT
});

module.exports = redisClient;
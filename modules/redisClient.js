const redis = require('redis');
const config = require('../config');

const logger = require('./logger');

const redisClient = redis.createClient({
    url: `redis://${config.REDIS_HOST}:${config.REDIS_PORT}`
});

// 没有 error 监听时，连接抖动会让 'error' 事件变成 uncaughtException，直接带走整个进程
redisClient.on('error', (error) => logger.err(error, 'REDIS'));

module.exports = redisClient;
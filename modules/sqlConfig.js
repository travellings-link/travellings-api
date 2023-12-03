// ____   ___  _           ____             __ _       
// / ___| / _ \| |         / ___|___  _ __  / _(_) __ _ 
// \___ \| | | | |   _____| |   / _ \| '_ \| |_| |/ _` |
//  ___) | |_| | |__|_____| |__| (_) | | | |  _| | (_| |
// |____/ \__\_\_____|     \____\___/|_| |_|_| |_|\__, |
//                                                |___/ 
// By BLxcwg666 <huixcwggmail.com>

const dotenv = require('dotenv').config();
const { Sequelize } = require('sequelize');

const sql = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'mysql',
    logging: false,
});

module.exports = sql;
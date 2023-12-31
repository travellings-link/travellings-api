// ____   ___  _          __  __           _      _ 
// / ___| / _ \| |        |  \/  | ___   __| | ___| |
// \___ \| | | | |   _____| |\/| |/ _ \ / _` |/ _ \ |
//  ___) | |_| | |__|_____| |  | | (_) | (_| |  __/ |
// |____/ \__\_\_____|    |_|  |_|\___/ \__,_|\___|_|
// 
// By BLxcwg666 <huixcwg@gmail.com>

const { DataTypes } = require('sequelize');
const sql = require('./sqlConfig');

const sqlModel = sql.define('webs', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  link: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  tag: {
    type: DataTypes.STRING,
    allowNull: false,
  },
}, {
  timestamps: false,
});

module.exports = sqlModel;
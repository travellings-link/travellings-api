//  ____   ___  _          __  __           _      _
// / ___| / _ \| |        |  \/  | ___   __| | ___| |
// \___ \| | | | |   _____| |\/| |/ _ \ / _` |/ _ \ |
//  ___) | |_| | |__|_____| |  | | (_) | (_| |  __/ |
// |____/ \__\_\_____|    |_|  |_|\___/ \__,_|\___|_|
//
// By BLxcwg666 <huixcwg@gmail.com>

const { DataTypes } = require("sequelize");
const sql = require("./sqlConfig");

const webModel = sql.define(
	"webs",
	{
		id: {
			type: DataTypes.INTEGER,
			autoIncrement: true,
			primaryKey: true,
		},
		status: {
			type: DataTypes.STRING,
			allowNull: true,
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
			allowNull: true,
		},
		failedReason: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		lastManualCheck: {
			type: DataTypes.DATE,
			allowNull: true,
		},
	},
	{
		timestamps: false,
	}
);

const userModel = sql.define(
	"users",
	{
		id: {
			type: DataTypes.INTEGER,
			autoIncrement: true,
			primaryKey: true,
		},
		user: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		token: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		role: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		lastLogin: {
			type: DataTypes.STRING,
			allowNull: true,
		},
	},
	{
		timestamps: false,
	}
);

const rssModel = sql.define(
	"rss",
	{
		id: {
			type: DataTypes.INTEGER,
			autoIncrement: true,
			primaryKey: true,
		},
		name: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		content: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		lastUpdate: {
			type: DataTypes.TIME,
			allowNull: true,
		},
		originLink: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		rssLink: {
			type: DataTypes.STRING,
			allowNull: false,
		},
	},
	{
		timestamps: false,
	}
);

module.exports = { webModel, userModel, rssModel };

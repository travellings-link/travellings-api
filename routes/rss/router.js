// ____             _            
// |  _ \ ___  _   _| |_ ___ _ __ 
// | |_) / _ \| | | | __/ _ \ '__|
// |  _ < (_) | |_| | ||  __/ |   
// |_| \_\___/ \__,_|\__\___|_|   
//         
// By BLxcwg666 <huixcwg@gmail.com>

const log = require('./logger');
const express = require("express");
const dotenv = require("dotenv").config();

const router = express.Router();

router.use('/all', require('./all'));  // 所有条目
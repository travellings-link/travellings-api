/* Shit Algorithm by BLxcwg666
TG：@xcnya / @xcnyacn
E-mail：huixcwg@gmail.com
License：GNU General Public License v3.0 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const dotenv = require('dotenv').config();

function encryption(input, customKey) {
  const encryptInput = input + '@' + customKey;
  const aesCipher = crypto.createCipheriv('aes-256-cbc', crypto.randomBytes(32), crypto.randomBytes(16));
  let aesEncrypted = aesCipher.update(encryptInput, 'utf-8', 'hex');
  aesEncrypted += aesCipher.final('hex');
  const bcryptHash = bcrypt.hashSync(aesEncrypted, 10);
  return bcryptHash;
}

module.exports = encryption;

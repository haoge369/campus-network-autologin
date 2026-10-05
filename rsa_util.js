// RSA 加密模块，基于锐捷 eportal 官方 security.js
const fs = require('fs');
const path = require('path');

// 模拟 window 对象以兼容官方 security.js
const sandbox = {
  window: {}
};
sandbox.window.window = sandbox.window;

const securityCode = fs.readFileSync(path.join(__dirname, 'security.js'), 'utf-8');
const vm = require('vm');
vm.runInNewContext(securityCode, sandbox);

const RSAUtils = sandbox.window.RSAUtils;

/**
 * 锐捷 eportal 密码加密函数
 * @param {string} password 明文密码
 * @param {string} mac URL 参数中的 mac 字符串
 * @param {string} exponent 公钥指数（通常为 10001）
 * @param {string} modulus 公钥模数
 * @returns {string} 加密后的密文
 */
function encryptPassword(password, mac, exponent = '10001', modulus) {
  const macStr = mac || '111111111';
  let passwordMac = password + '>' + macStr;
  let passwordEncode = passwordMac.split('').reverse().join('');
  
  RSAUtils.setMaxDigits(400);
  const key = new RSAUtils.getKeyPair(exponent, '', modulus);
  return RSAUtils.encryptedString(key, passwordEncode);
}

module.exports = {
  encryptPassword,
  RSAUtils
};

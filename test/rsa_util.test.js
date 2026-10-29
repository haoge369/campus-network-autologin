'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { encryptPassword } = require('../rsa_util');

// 测试用模数：只要是不为偶数的十六进制大数即可，不参与真实认证
const MODULUS = 'ab'.repeat(127) + 'cd';
const MAC = 'd8bbc1a1b2c3';
const PASSWORD = 'Fixture-Pass-9x';

test('encryptPassword: 输出十六进制密文且结果确定', () => {
  const a = encryptPassword(PASSWORD, MAC, '10001', MODULUS);
  const b = encryptPassword(PASSWORD, MAC, '10001', MODULUS);

  assert.ok(a.length > 0);
  assert.match(a, /^[0-9a-f]+$/i);
  assert.strictEqual(a, b);
});

test('encryptPassword: 密码或 MAC 变化会改变密文', () => {
  const base = encryptPassword(PASSWORD, MAC, '10001', MODULUS);
  assert.notStrictEqual(base, encryptPassword(`${PASSWORD}7`, MAC, '10001', MODULUS));
  assert.notStrictEqual(base, encryptPassword(PASSWORD, 'ffffffffffff', '10001', MODULUS));
});

test('encryptPassword: 默认指数为 10001', () => {
  const withDefault = encryptPassword(PASSWORD, MAC, undefined, MODULUS);
  const explicit = encryptPassword(PASSWORD, MAC, '10001', MODULUS);
  assert.strictEqual(withDefault, explicit);
});

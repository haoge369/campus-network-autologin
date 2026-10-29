'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseKeyValues } = require('../nic_ctl');

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

test('parseKeyValues: 解码 *_B64 中文并保留普通键', () => {
  const output = [
    'RESULT=enabled',
    `ADAPTER_B64=${b64('以太网')}`,
    'METHOD=pnp',
    'STATUS=Disabled',
    'STATUS_AFTER=Disconnected',
    `MESSAGE_B64=${b64('设备被禁用')}`
  ].join('\r\n');

  const parsed = parseKeyValues(output);
  assert.strictEqual(parsed.RESULT, 'enabled');
  assert.strictEqual(parsed.ADAPTER, '以太网');
  assert.strictEqual(parsed.METHOD, 'pnp');
  assert.strictEqual(parsed.STATUS, 'Disabled');
  assert.strictEqual(parsed.STATUS_AFTER, 'Disconnected');
  assert.strictEqual(parsed.MESSAGE, '设备被禁用');
});

test('parseKeyValues: 忽略空行、日志行和非法 base64', () => {
  const parsed = parseKeyValues(['', 'some warning text', 'RESULT=ok', 'X_B64=@@@'].join('\n'));
  assert.strictEqual(parsed.RESULT, 'ok');
  assert.strictEqual(parsed.X, '');
  assert.strictEqual(Object.keys(parsed).length, 2);
});

test('parseKeyValues: 空输入返回空对象', () => {
  assert.deepStrictEqual(parseKeyValues(''), {});
  assert.deepStrictEqual(parseKeyValues(null), {});
});

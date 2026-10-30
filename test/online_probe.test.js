'use strict';

const test = require('node:test');
const assert = require('node:assert');

const login = require('../campus_login');

const RTS_302_SUCCESS = {
  rtsStatus: 302,
  rtsLocation: 'http://172.10.110.252/eportal/./success.jsp?userIndex=abc'
};

test('interpretOnlineProbe: getOnlineUserInfo 只要带 userIndex 就算在线（不强制 result 字段）', () => {
  const result = login.interpretOnlineProbe({
    gouiStatus: 200,
    gouiBody: JSON.stringify({ userIndex: '3139abc_172.10.225.25_20240000001' }),
    rtsStatus: 200
  });
  assert.strictEqual(result.online, true);
  assert.strictEqual(result.detail.gouiLen > 0, true);
});

test('interpretOnlineProbe: 空体 + redirectortosuccess 302 success.jsp 判在线', () => {
  const result = login.interpretOnlineProbe({
    gouiStatus: 200,
    gouiBody: '',
    ...RTS_302_SUCCESS
  });
  assert.strictEqual(result.online, true);
});

test('interpretOnlineProbe: 空体 + 门户根路径 302 redirectortosuccess 判在线', () => {
  const result = login.interpretOnlineProbe({
    gouiStatus: 200,
    gouiBody: '',
    rtsStatus: 200,
    rootStatus: 302,
    rootLocation: 'http://172.10.110.252/eportal/redirectortosuccess.jsp'
  });
  assert.strictEqual(result.online, true);
});

test('interpretOnlineProbe: 三个信号都为空/异常时判离线', () => {
  const result = login.interpretOnlineProbe({
    gouiStatus: 200,
    gouiBody: '',
    rtsStatus: 200,
    rootStatus: 200
  });
  assert.strictEqual(result.online, false);
  assert.deepStrictEqual(result.detail, { gouiStatus: 200, gouiLen: 0, rtsStatus: 200, rootStatus: 200 });
});

test('interpretOnlineProbe: 非 JSON 的 getOnlineUserInfo 响应不误判为在线', () => {
  const result = login.interpretOnlineProbe({
    gouiStatus: 200,
    gouiBody: '<html>login</html>',
    rtsStatus: 200,
    rootStatus: 200
  });
  assert.strictEqual(result.online, false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const nc = require('../network_client');

function nic(name, address, extra = {}) {
  return {
    name,
    address,
    family: 'IPv4',
    mac: 'AA-BB-CC-DD-EE-FF',
    internal: false,
    ...extra
  };
}

test('pickCampusInterface: 优先选择 172.10.x.x 网卡', () => {
  const picked = nc.pickCampusInterface([
    nic('WLAN', '192.168.1.5'),
    nic('以太网', '172.10.1.100', { mac: 'D8-BB-C1-A1-B2-C3' }),
    nic('Meta', '198.18.0.2')
  ]);
  assert.ok(picked);
  assert.strictEqual(picked.name, '以太网');
});

test('pickCampusInterface: 没有校园网网卡时回退到首个可用网卡', () => {
  const picked = nc.pickCampusInterface([nic('WLAN', '192.168.1.5')]);
  assert.ok(picked);
  assert.strictEqual(picked.address, '192.168.1.5');
});

test('pickCampusInterface: 排除 loopback / APIPA / 代理 TUN', () => {
  const picked = nc.pickCampusInterface([
    nic('Loopback', '127.0.0.1', { internal: true }),
    nic('Meta', '198.18.0.2'),
    nic('APIPA', '169.254.10.20'),
    nic('v6', 'fe80::1', { family: 'IPv6' })
  ]);
  assert.strictEqual(picked, null);
});

test('macToSalt: 去掉分隔符并转小写', () => {
  assert.strictEqual(nc.macToSalt('D8-BB-C1-A1-B2-C3'), 'd8bbc1a1b2c3');
  assert.strictEqual(nc.macToSalt('D8:BB:C1:A1:B2:C3'), 'd8bbc1a1b2c3');
  assert.strictEqual(nc.macToSalt(null), '');
  assert.strictEqual(nc.macToSalt('xyz'), '');
});

test('isNetworkError: 识别网络类错误', () => {
  const enet = new Error('connect ENETUNREACH 172.10.110.252:80');
  enet.code = 'ENETUNREACH';
  assert.strictEqual(nc.isNetworkError(enet), true);

  const timeout = new Error('请求超时');
  timeout.code = 'ETIMEDOUT';
  assert.strictEqual(nc.isNetworkError(timeout), true);

  assert.strictEqual(nc.isNetworkError(new Error('认证失败: 密码错误')), false);
  assert.strictEqual(nc.isNetworkError(null), false);
});

test('isBindingError: 只有绑定相关的错误才需要去绑定重试', () => {
  const eaddrinuse = new Error('address not available');
  eaddrinuse.code = 'EADDRNOTAVAIL';
  assert.strictEqual(nc.isBindingError(eaddrinuse), true);

  const timeout = new Error('timeout');
  timeout.code = 'ETIMEDOUT';
  assert.strictEqual(nc.isBindingError(timeout), false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cl = require('../campus_login');

test('formatTime: 固定 YYYY-MM-DD HH:mm:ss 格式（不依赖系统区域设置）', () => {
  const text = cl.formatTime(new Date(2026, 9, 29, 8, 5, 9));
  assert.strictEqual(text, '2026-10-29 08:05:09');
  assert.match(cl.formatTime(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('stripQueryString: 取出 ? 之后的参数', () => {
  assert.strictEqual(
    cl.stripQueryString('http://172.10.110.252/eportal/index.jsp?wlanuserip=1&mac=aa'),
    'wlanuserip=1&mac=aa'
  );
  assert.strictEqual(cl.stripQueryString('http://1.1.1.1/'), null);
  assert.strictEqual(cl.stripQueryString('http://1.1.1.1/?'), null);
  assert.strictEqual(cl.stripQueryString(null), null);
});

test('extractMacFromQueryString: 原始 / 编码 / 缺失', () => {
  assert.strictEqual(cl.extractMacFromQueryString('wlanuserip=1&mac=d8bbc1a1b2c3'), 'd8bbc1a1b2c3');
  assert.strictEqual(cl.extractMacFromQueryString('mac=D8BBC1A1B2C3&x=1'), 'D8BBC1A1B2C3');
  assert.strictEqual(cl.extractMacFromQueryString('mac=d8%3Abb%3Ac1%3Aa1%3Ab2%3Ac3'), 'd8:bb:c1:a1:b2:c3');
  assert.strictEqual(cl.extractMacFromQueryString('wlanuserip=1'), null);
  assert.strictEqual(cl.extractMacFromQueryString(''), null);
  assert.strictEqual(cl.extractMacFromQueryString(null), null);
});

test('classifyError: 分成 network / auth / config / unknown', () => {
  const netErr = new Error('connect ENETUNREACH');
  netErr.code = 'ENETUNREACH';
  assert.strictEqual(cl.classifyError(netErr), 'network');

  assert.strictEqual(cl.classifyError(new cl.AuthError('密码错误')), 'auth');
  assert.strictEqual(cl.classifyError(new cl.ConfigError('缺少 userId')), 'config');
  assert.strictEqual(cl.classifyError(new Error('未知问题')), 'unknown');
  assert.strictEqual(cl.classifyError(null), 'unknown');
});

test('mergeConfig: 补默认值、规整数值、复制数组', () => {
  const merged = cl.mergeConfig({ serverHost: '10.0.0.1', retryCount: '5', probeUrls: ['http://a/'] });
  assert.strictEqual(merged.serverHost, '10.0.0.1');
  assert.strictEqual(merged.retryCount, 5);
  assert.deepStrictEqual(merged.probeUrls, ['http://a/']);
  assert.strictEqual(merged.nicEnableWaitMs, cl.DEFAULTS.nicEnableWaitMs);
  assert.strictEqual(merged.service, '');
  // 非法数值回落到默认值
  assert.strictEqual(cl.mergeConfig({ retryCount: 0 }).retryCount, cl.DEFAULTS.retryCount);
  assert.strictEqual(cl.mergeConfig({ retryCount: 'abc' }).retryCount, cl.DEFAULTS.retryCount);
  // 默认数组不被外部修改
  const a = cl.mergeConfig({});
  a.probeUrls.push('http://evil/');
  assert.strictEqual(cl.mergeConfig({}).probeUrls.includes('http://evil/'), false);
});

test('parseArgs: 识别各命令行选项', () => {
  assert.deepStrictEqual(cl.parseArgs([]), {
    force: false,
    quiet: false,
    status: false,
    help: false,
    auto: false,
    daily: false
  });
  const parsed = cl.parseArgs(['--force', '--status', '-q']);
  assert.strictEqual(parsed.force, true);
  assert.strictEqual(parsed.status, true);
  assert.strictEqual(parsed.quiet, true);
  assert.strictEqual(parsed.auto, false);
  assert.strictEqual(parsed.daily, false);
  assert.strictEqual(cl.parseArgs(['-h']).help, true);
  assert.strictEqual(cl.parseArgs(['--auto']).auto, true);
  assert.strictEqual(cl.parseArgs(['--daily']).daily, true);
  assert.strictEqual(cl.parseArgs(['--unknown']).force, false);
});

test('rotateLogIfNeeded: 超过上限才轮转，只保留一份历史', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-log-'));
  const logPath = path.join(dir, 'campus_login.log');
  try {
    fs.writeFileSync(logPath, 'small');
    assert.strictEqual(cl.rotateLogIfNeeded(1024, logPath), false);

    fs.writeFileSync(logPath, 'x'.repeat(4096));
    assert.strictEqual(cl.rotateLogIfNeeded(1024, logPath), true);
    assert.strictEqual(fs.existsSync(`${logPath}.1`), true);
    assert.strictEqual(fs.existsSync(logPath), false);

    // 再写一次并轮转，旧的 .1 被替换（只留一份）
    fs.writeFileSync(logPath, 'y'.repeat(4096));
    assert.strictEqual(cl.rotateLogIfNeeded(1024, logPath), true);
    assert.strictEqual(fs.readFileSync(`${logPath}.1`, 'utf8').length, 4096);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireLock: 单实例互斥、释放后可再次获取', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-lock-'));
  const lockPath = path.join(dir, 'campus_login.lock');
  try {
    assert.strictEqual(cl.acquireLock(lockPath), true);
    assert.strictEqual(cl.acquireLock(lockPath), false);
    cl.releaseLock(lockPath);
    assert.strictEqual(fs.existsSync(lockPath), false);
    assert.strictEqual(cl.acquireLock(lockPath), true);
    cl.releaseLock(lockPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireLock: 清理"进程已死"的陈旧锁', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-lock-'));
  const lockPath = path.join(dir, 'campus_login.lock');
  try {
    fs.writeFileSync(lockPath, '99999999\n2000-01-01T00:00:00.000Z\n');
    assert.strictEqual(cl.acquireLock(lockPath), true);
    cl.releaseLock(lockPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('EXIT 退出码语义固定', () => {
  assert.deepStrictEqual(cl.EXIT, { OK: 0, LOGIN_FAILED: 1, NETWORK_NOT_READY: 2, CONFIG_ERROR: 3 });
});

test('isPortalQueryString: 只接受门户参数，忽略通用 302', () => {
  assert.strictEqual(cl.isPortalQueryString('wlanuserip=1&mac=abc&t=wireless-v2'), true);
  assert.strictEqual(cl.isPortalQueryString('nasip=1&ssid='), true);
  assert.strictEqual(cl.isPortalQueryString('LinkID=219472&clcid=0x409'), false);
  assert.strictEqual(cl.isPortalQueryString(''), false);
  assert.strictEqual(cl.isPortalQueryString(null), false);
});

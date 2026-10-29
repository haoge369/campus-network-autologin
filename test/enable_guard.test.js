'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const login = require('../campus_login');

const BOOT = login.getBootId();
const state = (over = {}) => ({ bootId: BOOT, bootHandledAt: 0, enableCount: 0, lastEnableAt: 0, ...over });

const decide = (over = {}) =>
  login.shouldAutoEnable({
    interactive: false,
    mode: 'once',
    adapterState: 'disabled',
    state: state(),
    bootId: BOOT,
    ...over
  });

function tempStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-state-'));
  const file = path.join(dir, 'state.json');
  return { dir, file };
}

test('shouldAutoEnable: 手动运行始终允许启用', () => {
  const result = decide({ interactive: true, adapterState: 'disabled' });
  assert.deepStrictEqual(result, { allow: true, reason: 'manual-run' });
});

test('shouldAutoEnable: autoEnable=never 时任何情况都不启用', () => {
  assert.strictEqual(decide({ mode: 'never' }).allow, false);
  assert.strictEqual(decide({ mode: 'never', interactive: true }).allow, false);
});

test('shouldAutoEnable: 本次开机第一次自动运行允许启用', () => {
  const result = decide({ adapterState: 'disabled' });
  assert.deepStrictEqual(result, { allow: true, reason: 'first-run-this-boot' });
});

test('shouldAutoEnable: 本次开机已处理过网卡后不再启用（本 bug 的核心修复）', () => {
  const result = decide({ adapterState: 'disabled', state: state({ bootHandledAt: 12345 }) });
  assert.deepStrictEqual(result, { allow: false, reason: 'boot-handled' });
});

test('shouldAutoEnable: 状态文件属于上次开机时视为新开机，允许启用', () => {
  const result = decide({ adapterState: 'disabled', state: state({ bootId: 'old-boot', bootHandledAt: 12345 }) });
  assert.strictEqual(result.allow, true);
});

test('shouldAutoEnable: autoEnable=always 恢复旧行为（每次都允许）', () => {
  const result = decide({
    mode: 'always',
    adapterState: 'disabled',
    state: state({ bootHandledAt: 12345 })
  });
  assert.deepStrictEqual(result, { allow: true, reason: 'mode-always' });
});

test('shouldAutoEnable: 网卡已启用 / 找不到 / 状态未知时不启用', () => {
  assert.strictEqual(decide({ adapterState: 'enabled' }).reason, 'already-enabled');
  assert.strictEqual(decide({ adapterState: 'unknown' }).reason, 'already-enabled');
  assert.strictEqual(decide({ adapterState: 'notfound' }).reason, 'notfound');
  assert.strictEqual(decide({ adapterState: 'error' }).reason, 'state-error');
});

test('getBootId: 同一次开机内稳定，重启后变化', () => {
  const a = login.getBootId(1700000000000, 1000);
  const b = login.getBootId(1700000600000, 1600);
  const c = login.getBootId(1700000600000, 50); // 重启后 uptime 归零
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

test('loadState / saveState: 读写与容错', () => {
  const { dir, file } = tempStatePath();
  try {
    assert.deepStrictEqual(login.loadState(file), {
      bootId: '',
      bootHandledAt: 0,
      enableCount: 0,
      lastEnableAt: 0
    });

    assert.strictEqual(
      login.saveState({ bootId: BOOT, bootHandledAt: 42, enableCount: 1, lastEnableAt: 43 }, file),
      true
    );
    assert.deepStrictEqual(login.loadState(file), {
      bootId: BOOT,
      bootHandledAt: 42,
      enableCount: 1,
      lastEnableAt: 43
    });

    fs.writeFileSync(file, 'not json', 'utf8');
    assert.deepStrictEqual(login.loadState(file), {
      bootId: '',
      bootHandledAt: 0,
      enableCount: 0,
      lastEnableAt: 0
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('markBootHandled: 手动运行不占用开机额度', () => {
  const { dir, file } = tempStatePath();
  try {
    assert.strictEqual(login.markBootHandled({ autoEnable: 'once' }, { interactive: true }, file), false);
    assert.strictEqual(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('markBootHandled: 自动运行写入开机额度，之后自动运行不再启用', () => {
  const { dir, file } = tempStatePath();
  try {
    assert.strictEqual(login.markBootHandled({ autoEnable: 'once' }, { interactive: false }, file), true);
    const written = login.loadState(file);
    assert.strictEqual(written.bootId, BOOT);
    assert.ok(written.bootHandledAt > 0);

    const after = login.shouldAutoEnable({
      interactive: false,
      mode: 'once',
      adapterState: 'disabled',
      state: written,
      bootId: BOOT
    });
    assert.deepStrictEqual(after, { allow: false, reason: 'boot-handled' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('markBootHandled: autoEnable=always 时不写状态', () => {
  const { dir, file } = tempStatePath();
  try {
    assert.strictEqual(login.markBootHandled({ autoEnable: 'always' }, { interactive: false }, file), false);
    assert.strictEqual(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

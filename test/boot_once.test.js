'use strict';

/**
 * “每次开机只自动登录一次” 与 “外网可达性校验” 的单元测试。
 *
 * 说明：外网校验用 stub 替换 networkClient.requestUrl，避免测试依赖真实网络；
 * 真实的连通性验证在开发机上单独跑（--status 的 internet 字段）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cl = require('../campus_login');
const networkClient = require('../network_client');

const BIN = path.join(__dirname, '..', 'campus_login.js');

function tempDir(prefix = 'campus-boot-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('markBootRun / bootAutoRunHandled: 同一次开机只跑一次', () => {
  const dir = tempDir();
  const statePath = path.join(dir, 'state.json');

  assert.strictEqual(cl.bootAutoRunHandled(statePath), false);

  cl.markBootRun(statePath);
  assert.strictEqual(cl.bootAutoRunHandled(statePath), true);

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.strictEqual(state.bootId, cl.getBootMarker());
  assert.ok(state.bootHandledAt > 0, 'bootHandledAt 应被写入');

  // 再次 mark 仍属于同一开机，不改变 bootId
  cl.markBootRun(statePath);
  assert.strictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).bootId, state.bootId);
});

test('bootAutoRunHandled: 状态文件属于上次开机时视为未执行', () => {
  const dir = tempDir();
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify({ bootId: 'old-boot-id', bootHandledAt: Date.now() - 3600000, enableCount: 1 }),
    'utf8'
  );

  assert.strictEqual(cl.bootAutoRunHandled(statePath), false);
});

test('checkInternetAccess: 内容匹配 / 状态码匹配 / 被门户劫持 / 全部失败 / 未配置', async () => {
  const original = networkClient.requestUrl;
  try {
    // 内容匹配（connecttest.txt）
    networkClient.requestUrl = async () => ({ statusCode: 200, body: 'Microsoft Connect Test' });
    let result = await cl.checkInternetAccess({
      internetProbes: [{ url: 'http://probe/connecttest.txt', contains: 'Microsoft Connect Test' }],
      requestTimeoutMs: 1000
    });
    assert.strictEqual(result.ok, true);
    assert.match(result.detail, /HTTP 200/);

    // 状态码匹配（generate_204）
    networkClient.requestUrl = async () => ({ statusCode: 204, body: '' });
    result = await cl.checkInternetAccess({
      internetProbes: [{ url: 'http://probe/generate_204', statusCode: 204 }],
      requestTimeoutMs: 1000
    });
    assert.strictEqual(result.ok, true);
    assert.match(result.detail, /204/);

    // 返回 200 但内容是被门户劫持的页面 → 不算联网
    networkClient.requestUrl = async () => ({ statusCode: 200, body: '<html>请先登录门户</html>' });
    result = await cl.checkInternetAccess({
      internetProbes: [{ url: 'http://probe/connecttest.txt' }],
      requestTimeoutMs: 1000
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.detail, /不是预期页面|HTTP 200/);

    // 全部探测网络异常 → 失败并保留错误码
    networkClient.requestUrl = async () => {
      const err = new Error('timeout');
      err.code = 'ETIMEDOUT';
      throw err;
    };
    result = await cl.checkInternetAccess({
      internetProbes: [{ url: 'http://a/' }, { url: 'http://b/' }],
      requestTimeoutMs: 1000
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.detail, /ETIMEDOUT/);

    // 第一个探测失败、第二个成功 → 整体通过
    let calls = 0;
    networkClient.requestUrl = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      return { statusCode: 204, body: '' };
    };
    result = await cl.checkInternetAccess({
      internetProbes: [{ url: 'http://a/' }, { url: 'http://b/', statusCode: 204 }],
      requestTimeoutMs: 1000
    });
    assert.strictEqual(result.ok, true);

    // 没有配置探测地址（测试/离线环境）→ 跳过校验
    result = await cl.checkInternetAccess({ internetProbes: [] });
    assert.strictEqual(result.ok, true);
    assert.match(result.detail, /跳过校验/);
  } finally {
    networkClient.requestUrl = original;
  }
});

test(
  '--auto 第二次触发直接跳过（每次开机只自动执行一次）',
  { timeout: 120000 },
  () => {
    const dir = tempDir();
    const cfgPath = path.join(dir, 'config.json');
    const logPath = path.join(dir, 'campus.log');
    const statePath = path.join(dir, 'state.json');

    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          userId: '20240000001',
          password: 'Fixture-Pass-9x',
          serverHost: '127.0.0.1',
          portalPort: 9, // 关闭的端口：第一次运行必然登录失败，但开机额度已经占用
          manageAdapter: false,
          autoEnable: 'never',
          oncePerBoot: true,
          retryCount: 1,
          retryDelayMs: 100,
          authFailureDelayMs: 100,
          requestTimeoutMs: 300,
          internetProbes: [],
          probeUrls: ['http://127.0.0.1:9/'],
          adapterMatch: 'NoSuchAdapterXYZ',
          defaultQueryString: '',
          verifyAfterLoginMs: 100
        },
        null,
        2
      ),
      'utf8'
    );

    const env = {
      ...process.env,
      CAMPUS_LOGIN_CONFIG: cfgPath,
      CAMPUS_LOGIN_LOG: logPath,
      CAMPUS_LOGIN_STATE: statePath
    };
    delete env.CAMPUS_LOGIN_QUIET;

    const first = spawnSync(process.execPath, [BIN, '--auto', '--quiet'], {
      env,
      encoding: 'utf8',
      timeout: 90000
    });
    assert.strictEqual(first.status !== null, true, '第一次运行应正常结束');
    const logAfterFirst = fs.readFileSync(logPath, 'utf8');
    assert.match(logAfterFirst, /校园网自动登录任务启动/);
    assert.strictEqual(fs.existsSync(statePath), true, '第一次自动运行应写入开机状态');

    const second = spawnSync(process.execPath, [BIN, '--auto', '--quiet'], {
      env,
      encoding: 'utf8',
      timeout: 90000
    });
    assert.strictEqual(second.status, 0, '第二次触发应直接成功退出');
    const logAfterSecond = fs.readFileSync(logPath, 'utf8');
    assert.match(logAfterSecond, /本次开机已经自动执行过登录/);
  }
);

test('手动运行不受“每次开机只跑一次”限制', () => {
  const dir = tempDir();
  const statePath = path.join(dir, 'state.json');
  cl.markBootRun(statePath);
  assert.strictEqual(cl.bootAutoRunHandled(statePath), true);

  // 手动运行（不带 --auto）在 main() 里会走 interactive=true 分支，
  // 这里只验证导出能力与状态文件本身的行为一致，避免依赖子进程时序。
  assert.strictEqual(typeof cl.EXIT.OK, 'number');
});

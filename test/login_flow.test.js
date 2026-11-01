'use strict';

// 端到端（假门户）测试：用本地 HTTP 服务器模拟锐捷 eportal，
// 验证「抓 queryString → pageInfo 取公钥 → RSA 加密登录 → 二次校验」整条链路。
// 不触碰真实校园网，可在 CI 里跑。

const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-login-flow-'));
process.env.CAMPUS_LOGIN_LOG = path.join(tmpDir, 'campus_login.log');
process.env.CAMPUS_LOGIN_QUIET = '1';

const cl = require('../campus_login');

const MODULUS = 'ab'.repeat(127) + 'cd';
const EXPONENT = '10001';
// 测试用假账号（不是真实学号/密码）
const FIXTURE_USER_ID = '20240000001';
const FIXTURE_PASSWORD = 'Fixture-Pass-9x';
const PORTAL_QUERY =
  'wlanuserip=1.2.3.4&wlanacname=ac-name&ssid=&nasip=9.9.9.9&mac=d8:bb:c1:a1:b2:c3&t=wireless-v2&url=abc';

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function startFakePortal(options = {}) {
  const state = {
    loggedIn: false,
    loginBodies: [],
    pageInfoBodies: [],
    loginSucceeds: options.loginSucceeds !== false,
    verifyStaysOffline: Boolean(options.verifyStaysOffline),
    genericRedirect: Boolean(options.genericRedirect),
    pageInfoEmpty: Boolean(options.pageInfoEmpty),
    // 模拟「刚开机、认证网关还没放行」：前 N 次外网探测返回被劫持页面
    internetBlockedChecks: Number(options.internetBlockedChecks) || 0,
    internetChecks: 0,
    // 门户注销接口是否真的会结束会话（默认只是回 success，不影响状态）
    logoutWorks: Boolean(options.logoutWorks),
    logoutCalls: 0
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const method = url.searchParams.get('method');
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const json = (obj, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify(obj));
      };
      const redirect = (location) => {
        res.writeHead(302, { Location: location });
        res.end();
      };

      if (req.method === 'GET' && url.pathname === '/') {
        if (state.genericRedirect) {
          return redirect('http://go.microsoft.com/fwlink/?LinkID=219472&clcid=0x409');
        }
        if (state.loggedIn && !state.verifyStaysOffline) {
          return redirect(`${base}/eportal/redirectortosuccess.jsp`);
        }
        return redirect(`${base}/eportal/index.jsp?${PORTAL_QUERY}`);
      }

      if (url.pathname === '/eportal/InterFace.do' && method === 'pageInfo') {
        state.pageInfoBodies.push(body);
        if (state.loggedIn && state.pageInfoEmpty) {
          // 真实门户在「已在线」时对 pageInfo 返回空响应（不再下发公钥参数）
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
          return res.end('');
        }
        return json({ publicKeyExponent: EXPONENT, publicKeyModulus: MODULUS });
      }

      if (url.pathname === '/eportal/InterFace.do' && method === 'login') {
        state.loginBodies.push(body);
        if (!state.loginSucceeds) {
          return json({ result: 'fail', message: '账号或密码错误' });
        }
        state.loggedIn = true;
        return json({ result: 'success', userIndex: 'fake-user-index', message: '认证成功' });
      }

      if (url.pathname === '/eportal/InterFace.do' && method === 'getOnlineUserInfo') {
        const online = state.loggedIn && !state.verifyStaysOffline;
        return json(online ? { result: 'success', userIndex: 'fake-user-index' } : { result: 'fail' });
      }

      if (url.pathname === '/eportal/redirectortosuccess.jsp') {
        if (state.loggedIn && !state.verifyStaysOffline) {
          return redirect(`${base}/eportal/success.jsp?userIndex=abc`);
        }
        return json({ result: 'fail' });
      }

      // 外网可达性探测目标：前 internetBlockedChecks 次返回被门户劫持的页面
      if (req.method === 'GET' && url.pathname === '/__internet') {
        state.internetChecks += 1;
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
        if (state.internetChecks <= state.internetBlockedChecks) {
          return res.end('<html>请先登录校园网</html>');
        }
        return res.end('Microsoft Connect Test');
      }

      // 门户注销接口
      if (url.pathname === '/eportal/InterFace.do' && method === 'logout') {
        state.logoutCalls += 1;
        if (state.logoutWorks) state.loggedIn = false;
        return json({ result: 'success', message: '下线成功！' });
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, port: server.address().port });
    });
  });
}

function configFor(port, extra = {}) {
  return cl.mergeConfig({
    userId: FIXTURE_USER_ID,
    password: FIXTURE_PASSWORD,
    serverHost: '127.0.0.1',
    portalPort: port,
    manageAdapter: false,
    probeUrls: [],
    // 用假门户自己的 /__internet 当外网探测点，测试不依赖真实外网
    internetProbes: [
      { url: `http://127.0.0.1:${port}/__internet`, contains: 'Microsoft Connect Test' }
    ],
    defaultQueryString: '',
    retryCount: 2,
    retryDelayMs: 50,
    authFailureDelayMs: 10,
    requestTimeoutMs: 2000,
    verifyAfterLoginMs: 10,
    nicEnableWaitMs: 200,
    ...extra
  });
}

test('假门户：抓取实时 queryString → 登录 → 二次校验成功（退出码 0）', async () => {
  const portal = await startFakePortal();
  try {
    const config = configFor(portal.port);
    const result = await cl.runLogin(config, { force: false });
    assert.strictEqual(result.code, cl.EXIT.OK);
    assert.strictEqual(portal.state.loggedIn, true);
    assert.strictEqual(portal.state.pageInfoBodies.length, 1);
    assert.strictEqual(portal.state.loginBodies.length, 1);
    // queryString 是双重 URL 编码后提交的
    const doubleEncoded = encodeURIComponent(encodeURIComponent(PORTAL_QUERY));
    assert.ok(portal.state.pageInfoBodies[0].includes(doubleEncoded));
    // 登录体里带上了账号与加密后的密码
    assert.match(portal.state.loginBodies[0], new RegExp(`userId=${FIXTURE_USER_ID}`));
    assert.match(portal.state.loginBodies[0], /passwordEncrypt=true/);

    const logText = fs.readFileSync(process.env.CAMPUS_LOGIN_LOG, 'utf8');
    assert.match(logText, /二次校验通过/);
  } finally {
    portal.server.close();
  }
});

test('假门户：认证被拒时立刻停止（不空转重试，退出码 1）', async () => {
  const portal = await startFakePortal({ loginSucceeds: false });
  try {
    const result = await cl.runLogin(configFor(portal.port), { force: true });
    assert.strictEqual(result.code, cl.EXIT.LOGIN_FAILED);
    assert.strictEqual(portal.state.loginBodies.length, 1);
    const logText = fs.readFileSync(process.env.CAMPUS_LOGIN_LOG, 'utf8');
    assert.match(logText, /参数或认证问题，停止重试/);
  } finally {
    portal.server.close();
  }
});

test('假门户：登录接口成功但二次校验失败 → 重试到上限后退出码 1', async () => {
  const portal = await startFakePortal({ verifyStaysOffline: true });
  try {
    const result = await cl.runLogin(configFor(portal.port, { retryCount: 2 }), { force: true });
    assert.strictEqual(result.code, cl.EXIT.LOGIN_FAILED);
    assert.strictEqual(portal.state.loginBodies.length, 2);
    const logText = fs.readFileSync(process.env.CAMPUS_LOGIN_LOG, 'utf8');
    assert.match(logText, /二次校验/);
  } finally {
    portal.server.close();
  }
});

test('假门户：只有通用 302（无门户参数）且无兜底参数 → 配置错误退出码 3', async () => {
  const portal = await startFakePortal({ genericRedirect: true });
  try {
    const result = await cl.runLogin(configFor(portal.port), { force: true });
    assert.strictEqual(result.code, cl.EXIT.CONFIG_ERROR);
    assert.strictEqual(portal.state.pageInfoBodies.length, 0);
  } finally {
    portal.server.close();
  }
});

test('假门户：抓不到实时参数时回落到 defaultQueryString 并登录成功', async () => {
  const portal = await startFakePortal({ genericRedirect: true });
  try {
    const config = configFor(portal.port, { defaultQueryString: 'wlanuserip=1&mac=aaaa' });
    const result = await cl.runLogin(config, { force: true });
    assert.strictEqual(result.code, cl.EXIT.OK);
    assert.strictEqual(portal.state.loginBodies.length, 1);
  } finally {
    portal.server.close();
  }
});

test('假门户：门户已在线导致 pageInfo 空响应 → 复核在线后按成功处理（退出码 0）', async () => {
  const portal = await startFakePortal({ pageInfoEmpty: true });
  try {
    // 造出「一开始被判离线、真登录时门户却已在线」的现场：
    // 先登录一次把假门户置为已在线，再用 --force 走完整流程。
    portal.state.loggedIn = true;
    const config = configFor(portal.port, { defaultQueryString: 'wlanuserip=1&mac=aaaa' });
    const result = await cl.runLogin(config, { force: true });
    assert.strictEqual(result.code, cl.EXIT.OK);
    assert.strictEqual(result.reason, 'already-online');
    // 空 pageInfo 说明确实走到了「已在线」这条补偿分支，而不是正常登录
    assert.strictEqual(portal.state.pageInfoBodies.length, 1);
    assert.strictEqual(portal.state.loginBodies.length, 0);
  } finally {
    portal.server.close();
  }
});

test('假门户：门户说在线但外网暂不可达（刚开机网关未放行）→ 等待后恢复，退出码 0', async () => {
  const portal = await startFakePortal({ internetBlockedChecks: 2 });
  try {
    portal.state.loggedIn = true;
    const config = configFor(portal.port, {
      internetRetryCount: 3,
      internetRetryDelayMs: 20
    });
    const result = await cl.runLogin(config, { force: false });
    assert.strictEqual(result.code, cl.EXIT.OK);
    assert.strictEqual(result.reason, 'already-online-recovered');
    assert.ok(portal.state.internetChecks >= 3, '应多次复查外网');
    assert.strictEqual(portal.state.loginBodies.length, 0, '外网恢复后不该再发起重复认证');
    const logText = fs.readFileSync(process.env.CAMPUS_LOGIN_LOG, 'utf8');
    assert.match(logText, /外网已恢复可达/);
  } finally {
    portal.server.close();
  }
});

test('假门户：门户假在线一直不恢复 → 退出码 2（网络未就绪）', async () => {
  const portal = await startFakePortal({ internetBlockedChecks: 99 });
  try {
    portal.state.loggedIn = true;
    const config = configFor(portal.port, {
      internetRetryCount: 2,
      internetRetryDelayMs: 10
    });
    const result = await cl.runLogin(config, { force: false });
    assert.strictEqual(result.code, cl.EXIT.NETWORK_NOT_READY);
    assert.strictEqual(result.reason, 'portal-stale-session');
  } finally {
    portal.server.close();
  }
});

test('假门户：门户假在线但注销成功转为离线 → 自动重新认证登录成功（退出码 0）', async () => {
  const portal = await startFakePortal({ internetBlockedChecks: 1, logoutWorks: true });
  try {
    portal.state.loggedIn = true;
    const config = configFor(portal.port, {
      internetRetryCount: 3,
      internetRetryDelayMs: 10
    });
    const result = await cl.runLogin(config, { force: false });
    assert.strictEqual(result.code, cl.EXIT.OK);
    assert.strictEqual(result.reason, 'logged-in');
    assert.strictEqual(portal.state.logoutCalls, 1);
    assert.strictEqual(portal.state.loginBodies.length, 1);
  } finally {
    portal.server.close();
  }
});

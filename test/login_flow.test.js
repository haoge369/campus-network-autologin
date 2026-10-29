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
    genericRedirect: Boolean(options.genericRedirect)
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
        if (state.loggedIn) {
          return redirect(`${base}/eportal/redirectortosuccess.jsp`);
        }
        return redirect(`${base}/eportal/index.jsp?${PORTAL_QUERY}`);
      }

      if (url.pathname === '/eportal/InterFace.do' && method === 'pageInfo') {
        state.pageInfoBodies.push(body);
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

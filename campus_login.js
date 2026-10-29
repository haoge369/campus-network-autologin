// 锐捷 eportal 校园网自动登录（Windows）
//
// v1.1.0 主要变化：
//   1. 请求只绑定校园网网卡（172.10.x.x），修复历史 ENETUNREACH；
//   2. queryString 从门户网关实时重定向抓取，1.1.1.1 只作为备选探测；
//   3. 登录成功后二次校验会话，避免"接口成功但没网"的假成功；
//   4. MAC 缺失时用网卡真实 MAC，仍拿不到则失败（不再静默用 111111111）；
//   5. 单实例锁、错误分类 + 退避、退出码语义化、日志轮转；
//   6. --status / --help / --quiet / --force 命令行参数。
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const networkClient = require('./network_client');
const { encryptPassword } = require('./rsa_util');
const nicCtl = require('./nic_ctl');

const APP_VERSION = '1.1.0';
const SCRIPT_DIR = __dirname;
const CONFIG_PATH = process.env.CAMPUS_LOGIN_CONFIG
  ? path.resolve(process.env.CAMPUS_LOGIN_CONFIG)
  : path.join(SCRIPT_DIR, 'config.json');
const LOG_PATH = process.env.CAMPUS_LOGIN_LOG
  ? path.resolve(process.env.CAMPUS_LOGIN_LOG)
  : path.join(SCRIPT_DIR, 'campus_login.log');
const LOCK_PATH = path.join(SCRIPT_DIR, 'campus_login.lock');

// 退出码：让计划任务/外部脚本能区分"登录失败"和"网络还没就绪"
const EXIT = Object.freeze({
  OK: 0,
  LOGIN_FAILED: 1,
  NETWORK_NOT_READY: 2,
  CONFIG_ERROR: 3
});

const DEFAULTS = Object.freeze({
  serverHost: '172.10.110.252',
  portalPort: 80,
  manageAdapter: true,
  probeUrls: [
    'http://1.1.1.1/',
    'http://connect.rom.miui.com/generate_204',
    'http://www.msftconnecttest.com/redirect'
  ],
  adapterMatch: nicCtl.DEFAULT_ADAPTER_MATCH,
  nicEnableWaitMs: 60000,
  retryCount: 3,
  retryDelayMs: 15000,
  authFailureDelayMs: 3000,
  requestTimeoutMs: 5000,
  verifyAfterLoginMs: 1500,
  logMaxBytes: 1024 * 1024,
  lockStaleMs: 5 * 60 * 1000,
  service: '',
  operatorUserId: '',
  defaultQueryString: ''
});

const NUMERIC_KEYS = [
  'portalPort',
  'nicEnableWaitMs',
  'retryCount',
  'retryDelayMs',
  'authFailureDelayMs',
  'requestTimeoutMs',
  'verifyAfterLoginMs',
  'logMaxBytes',
  'lockStaleMs'
];

let quietMode = process.env.CAMPUS_LOGIN_QUIET === '1';

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

function formatTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * 日志超过上限时轮转成 xxx.log.1（只保留一份历史）。
 * @returns {boolean} 是否发生了轮转
 */
function rotateLogIfNeeded(maxBytes = DEFAULTS.logMaxBytes, logPath = LOG_PATH) {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size <= maxBytes) return false;
    const backup = `${logPath}.1`;
    try {
      fs.rmSync(backup, { force: true });
    } catch (err) {
      // 备份删除失败不影响主流程
    }
    fs.renameSync(logPath, backup);
    return true;
  } catch (err) {
    return false;
  }
}

function log(message) {
  const line = `[${formatTime()}] ${message}`;
  if (!quietMode) {
    try {
      console.log(line);
    } catch (err) {
      // 无控制台时忽略
    }
  }
  try {
    fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
  } catch (err) {
    // 日志写失败不影响登录
  }
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 合并默认配置，并把数值项规整成合法正数（导出以便单元测试）。 */
function mergeConfig(raw = {}, defaults = DEFAULTS) {
  const config = { ...defaults, ...(raw || {}) };
  config.probeUrls =
    Array.isArray(config.probeUrls) && config.probeUrls.length > 0
      ? config.probeUrls.slice()
      : defaults.probeUrls.slice();
  for (const key of NUMERIC_KEYS) {
    const value = Number(config[key]);
    config[key] = Number.isFinite(value) && value > 0 ? value : defaults[key];
  }
  // 端口超过 65535 时回落到默认 80，其他非法的数字交给下面的校验
  if (!Number.isInteger(config.portalPort) || config.portalPort > 65535) {
    config.portalPort = defaults.portalPort;
  }
  config.manageAdapter = config.manageAdapter !== false;
  return config;
}

/** 用 Windows DPAPI（当前用户）解密密码，避免 config.json 里存明文。 */
function decryptDpapi(encryptedBase64) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const powershell = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(powershell)) {
    throw new ConfigError('找不到 powershell.exe，无法解密 passwordEnc');
  }
  const script =
    "$ErrorActionPreference='Stop';" +
    "Add-Type -AssemblyName System.Security;" +
    `$b=[Convert]::FromBase64String('${encryptedBase64}');` +
    "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
    '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))';

  const result = spawnSync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 }
  );
  if (result.error) {
    throw new ConfigError(`密码解密失败: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new ConfigError(`密码解密失败: ${(result.stderr || '').trim() || `退出码 ${result.status}`}`);
  }
  const password = (result.stdout || '').trim();
  if (!password) throw new ConfigError('密码解密结果为空，请重新运行 protect_password.ps1');
  return password;
}

function loadConfig(configPath = CONFIG_PATH) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new ConfigError(`找不到配置文件: ${configPath}`);
  }

  let raw;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new ConfigError(`配置文件不是合法 JSON: ${err.message}`);
  }

  const config = mergeConfig(raw);
  if (!config.serverHost || typeof config.serverHost !== 'string') {
    throw new ConfigError('config.json 缺少 serverHost（认证服务器地址）');
  }
  if (!config.userId || typeof config.userId !== 'string') {
    throw new ConfigError('config.json 缺少 userId（学号/账号）');
  }
  if (config.passwordEnc) {
    config.password = decryptDpapi(String(config.passwordEnc));
  }
  if (!config.password || typeof config.password !== 'string') {
    throw new ConfigError('config.json 缺少 password，或 passwordEnc 解密失败');
  }
  return config;
}

// ---------------------------------------------------------------------------
// 单实例锁
// ---------------------------------------------------------------------------

function readPidFromLock(lockPath = LOCK_PATH) {
  try {
    const text = fs.readFileSync(lockPath, 'utf8');
    const pid = Number(String(text).split(/\r?\n/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (err) {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * 抢占单实例锁。并发双击时只有一个实例会真正执行。
 * @returns {boolean} 是否拿到锁
 */
function acquireLock(lockPath = LOCK_PATH, staleMs = DEFAULTS.lockStaleMs) {
  const create = () => {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    fs.closeSync(fd);
  };

  try {
    create();
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') return false;
  }

  let stale = true;
  try {
    const stat = fs.statSync(lockPath);
    stale = Date.now() - stat.mtimeMs >= staleMs;
  } catch (err) {
    stale = true;
  }
  const pid = readPidFromLock(lockPath);
  if (!stale && isPidAlive(pid)) return false;

  // 陈旧锁（进程已退出或超时）：清掉再抢一次
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    // 已被别人清掉也无妨
  }
  try {
    create();
    return true;
  } catch (err) {
    return false;
  }
}

function releaseLock(lockPath = LOCK_PATH) {
  try {
    if (readPidFromLock(lockPath) === process.pid) fs.unlinkSync(lockPath);
  } catch (err) {
    // 忽略
  }
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv = []) {
  const options = { force: false, quiet: false, status: false, help: false };
  for (const arg of argv) {
    if (arg === '--force' || arg === '-f') options.force = true;
    else if (arg === '--quiet' || arg === '-q' || arg === '/quiet') options.quiet = true;
    else if (arg === '--status' || arg === '-s') options.status = true;
    else if (arg === '--help' || arg === '-h' || arg === '/?') options.help = true;
  }
  return options;
}

function printHelp() {
  const text = [
    `校园网自动登录 v${APP_VERSION}`,
    '',
    '用法: node campus_login.js [选项]',
    '',
    '  --status, -s   只输出一行 JSON 状态（在线/离线、IP、网卡），不登录',
    '  --force,  -f   跳过在线检查，强制重新登录',
    '  --quiet,  -q   静默模式：不打印到控制台（日志照常写入）',
    '  --help,   -h   显示本帮助',
    '',
    '退出码: 0=成功/已在线  1=登录失败  2=网络未就绪  3=配置错误',
    '',
    `配置文件: ${CONFIG_PATH}`,
    `日志文件: ${LOG_PATH}`
  ].join('\n');
  console.log(text);
}

// ---------------------------------------------------------------------------
// 业务
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把错误归类：network / auth / config / unknown（导出以便单元测试）。 */
function classifyError(err) {
  if (!err) return 'unknown';
  if (err.name === 'AuthError') return 'auth';
  if (err.name === 'ConfigError') return 'config';
  if (networkClient.isNetworkError(err)) return 'network';
  return 'unknown';
}

/** 从 Location 或完整 URL 里取出 ? 之后的 queryString。 */
function stripQueryString(location) {
  if (!location) return null;
  const index = String(location).indexOf('?');
  if (index === -1) return null;
  const query = String(location).slice(index + 1);
  return query || null;
}

/**
 * 门户重定向的 queryString 一定带有 wlanuserip/nasip 等参数。
 * 用它挡掉 msftconnecttest 之类的通用 302（例如 go.microsoft.com 的 LinkID），
 * 否则会拿一段无关参数去请求 pageInfo，得到空响应并误判成登录失败。
 */
function isPortalQueryString(queryString) {
  if (!queryString) return false;
  return /(?:^|&)(?:wlanuserip|wlanacname|nasip|nasid|userip|ssid)=/i.test(queryString);
}

/** 从 queryString 里取 mac 参数（门户作为加密盐使用）。 */
function extractMacFromQueryString(queryString) {
  if (!queryString) return null;
  const match = /(?:^|&)mac=([^&]*)/i.exec(queryString);
  if (!match) return null;
  let value = match[1];
  try {
    value = decodeURIComponent(value);
  } catch (err) {
    // 保留原值
  }
  value = String(value).trim();
  // 门户返回的 mac 可能是 12 位裸十六进制、32 位加密串，也可能带冒号/横线
  return /^[0-9a-zA-Z:._-]{4,64}$/.test(value) ? value : null;
}

async function checkIsOnline(config) {
  const common = {
    host: config.serverHost,
    port: config.portalPort,
    timeoutMs: config.requestTimeoutMs
  };
  try {
    const res = await networkClient.request(
      {
        ...common,
        path: '/eportal/InterFace.do?method=getOnlineUserInfo',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
      },
      'userIndex='
    );

    if (res.body) {
      try {
        const data = JSON.parse(res.body);
        if (data.result === 'success' && data.userIndex) {
          return { online: true, userInfo: data };
        }
      } catch (err) {
        // 返回可能不是 JSON
      }
    }

    const redirect = await networkClient.request({
      ...common,
      path: '/eportal/redirectortosuccess.jsp',
      method: 'GET'
    });
    if (
      redirect.statusCode === 302 &&
      redirect.headers.location &&
      redirect.headers.location.includes('success.jsp')
    ) {
      return { online: true };
    }
    return { online: false, unreachable: false };
  } catch (err) {
    return {
      online: false,
      unreachable: networkClient.isNetworkError(err),
      error: err.message
    };
  }
}

/**
 * 实时抓取 queryString：先打门户网关（必然 302），再依次尝试配置的探测地址。
 * @returns {Promise<{queryString:string, source:string}|null>}
 */
function buildPortalUrl(config) {
  const port = Number(config.portalPort) || 80;
  return `http://${config.serverHost}${port === 80 ? '' : ':' + port}/`;
}

async function detectQueryString(config) {
  const candidates = [{ label: `门户网关 ${config.serverHost}`, url: buildPortalUrl(config) }];
  for (const probe of config.probeUrls || []) {
    candidates.push({ label: `探测地址 ${probe}`, url: probe });
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const res = await networkClient.requestUrl(candidate.url, {
        method: 'GET',
        timeoutMs: index === 0 ? config.requestTimeoutMs : Math.min(config.requestTimeoutMs, 3000)
      });
      const location = res.headers && res.headers.location;
      const queryString = stripQueryString(location);

      if (queryString && isPortalQueryString(queryString)) {
        log(`重定向捕获成功（${candidate.label}）: ${location}`);
        return { queryString, source: candidate.label };
      }

      // 门户把根路径跳到 redirectortosuccess 说明此刻已经在线，
      // 不会再下发新的 queryString，继续探测只会白等。
      if (index === 0 && location && location.includes('redirectortosuccess')) {
        log('门户返回「已登录」跳转（redirectortosuccess），当前无法获取实时参数。');
        return null;
      }

      if (queryString) {
        log(`忽略非门户重定向（${candidate.label}）: ${location}`);
      }
    } catch (err) {
      log(`探测 ${candidate.label} 失败: ${err.message}`);
    }
  }
  return null;
}

async function fetchPageInfo(config, queryString) {
  const body = `queryString=${encodeURIComponent(encodeURIComponent(queryString))}`;
  const res = await networkClient.request(
    {
      host: config.serverHost,
      port: config.portalPort,
      path: '/eportal/InterFace.do?method=pageInfo',
      method: 'POST',
      timeoutMs: config.requestTimeoutMs,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
    },
    body
  );

  if (res.statusCode !== 200) {
    throw new Error(`获取公钥信息失败，状态码: ${res.statusCode}`);
  }
  if (!res.body) {
    throw new AuthError(
      '门户对 pageInfo 返回空响应：通常表示当前已在线（门户不再下发新参数），或 queryString 已过期；离线时会自动抓取实时参数。'
    );
  }
  let data;
  try {
    data = JSON.parse(res.body);
  } catch (err) {
    throw new Error(`公钥接口返回非 JSON: ${(res.body || '').slice(0, 200)}`);
  }
  return data;
}

/**
 * 发起一次认证登录。
 * @returns {Promise<{ok:true, userIndex?:string, macSource:string}>}
 */
async function doLogin(config, queryString) {
  const pageInfo = await fetchPageInfo(config, queryString);

  const exponent = pageInfo.publicKeyExponent || '10001';
  const modulus = pageInfo.publicKeyModulus;
  if (!modulus) {
    throw new Error('未获取到有效的 RSA 公钥模数 (publicKeyModulus)，queryString 可能已过期');
  }

  let mac = extractMacFromQueryString(queryString);
  let macSource = 'queryString';
  if (!mac) {
    mac = networkClient.getCampusMac();
    macSource = '网卡 MAC';
    if (mac) {
      log(`queryString 中未找到 mac，改用网卡真实 MAC[${mac}] 作为加密盐。`);
    }
  }
  if (!mac) {
    throw new AuthError('无法获取 MAC（queryString 无 mac 且网卡 MAC 不可用），queryString 可能已过期，请检查网络连接');
  }

  log(`使用 MAC[${mac}]（来源: ${macSource}）与公钥加密密码...`);
  const encryptedPassword = encryptPassword(config.password, mac, exponent, modulus);

  const params = {
    userId: config.userId,
    password: encryptedPassword,
    service: config.service || '',
    queryString,
    operatorPwd: '',
    operatorUserId: config.operatorUserId || '',
    validcode: '',
    passwordEncrypt: 'true'
  };
  const body = Object.keys(params)
    .map((key) => `${key}=${encodeURIComponent(encodeURIComponent(params[key]))}`)
    .join('&');

  const res = await networkClient.request(
    {
      host: config.serverHost,
      port: config.portalPort,
      path: '/eportal/InterFace.do?method=login',
      method: 'POST',
      timeoutMs: config.requestTimeoutMs,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
    },
    body
  );

  if (res.statusCode !== 200) {
    throw new Error(`登录请求响应异常，状态码: ${res.statusCode}`);
  }

  let result;
  try {
    result = JSON.parse(res.body);
  } catch (err) {
    throw new Error(`登录返回格式非JSON: ${(res.body || '').slice(0, 200)}`);
  }

  if (result.result === 'success') {
    return { ok: true, userIndex: result.userIndex, message: result.message || '', macSource };
  }
  const reason = result.message || result.msg || JSON.stringify(result).slice(0, 200);
  throw new AuthError(`登录失败: ${reason}`);
}

/**
 * 步骤 0：确保物理网卡已启用，并等待校园网 IP 就绪。
 */
async function ensureCampusNetwork(config) {
  if (config.manageAdapter === false) {
    const current = networkClient.getCampusIp();
    log(current ? `manageAdapter=false，跳过网卡自愈检查（当前 IP: ${current}）` : 'manageAdapter=false，跳过网卡自愈检查（当前未获取到校园网 IP）');
    return current;
  }

  let ip = networkClient.getCampusIp();
  if (ip) {
    log(`检测到校园网地址: ${ip}`);
    return ip;
  }

  log('未检测到校园网地址 (172.10.x.x)，检查物理网卡是否被禁用...');

  let adapterName = null;
  try {
    const result = await nicCtl.ensureCampusAdapter(config.adapterMatch);
    adapterName = result.adapter || null;
    if (result.action === 'enabled') {
      log(
        `物理网卡「${result.adapter || config.adapterMatch}」原本处于禁用状态（方式: ${result.method}），已自动启用。`
      );
    } else if (result.action === 'already') {
      log(`物理网卡「${result.adapter || config.adapterMatch}」已启用（状态: ${result.status}），但尚未获取到校园网 IP。`);
    } else if (result.action === 'notfound') {
      log(`未找到匹配「${config.adapterMatch}」的物理网卡，请检查 config.json 中的 adapterMatch。`);
    } else if (result.action === 'error') {
      log(`启用物理网卡失败: ${result.message || '未知错误'}（若当前不是管理员，请右键以管理员身份运行）。`);
    }
  } catch (err) {
    log(`启用物理网卡时发生异常: ${err.message}`);
  }

  if (networkClient.getCampusIp()) {
    ip = networkClient.getCampusIp();
    log(`校园网 IP 已就绪: ${ip}`);
    return ip;
  }

  log(`正在等待校园网 IP 就绪（最多 ${Math.round(config.nicEnableWaitMs / 1000)} 秒）...`);
  ip = await waitForCampusIpWithRenew(adapterName, config.nicEnableWaitMs);
  return ip;
}

/** 轮询等待 172.10.x.x；中途会刷新 DHCP 租约（最多 3 次）。 */
async function waitForCampusIpWithRenew(adapterName, timeoutMs) {
  const start = Date.now();
  let lastRenewAt = 0;
  let renewCount = 0;
  let lastTickAt = 0;

  for (;;) {
    const ip = networkClient.getCampusIp();
    if (ip) {
      log(`校园网 IP 已就绪: ${ip}`);
      return ip;
    }

    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) return null;

    if (adapterName && renewCount < 3 && elapsed >= 8000 && Date.now() - lastRenewAt >= 15000) {
      renewCount += 1;
      lastRenewAt = Date.now();
      log(`等待 ${Math.round(elapsed / 1000)} 秒仍未拿到 IP，刷新 DHCP 租约 (ipconfig /renew，第 ${renewCount} 次)...`);
      try {
        await nicCtl.renewAdapterDhcp(adapterName);
        log('DHCP 租约刷新请求已发出。');
      } catch (err) {
        log(`刷新 DHCP 租约失败: ${err.message}`);
      }
    }

    if (elapsed - lastTickAt >= 5000) {
      lastTickAt = elapsed;
      log(`  ...已等待 ${Math.round(elapsed / 1000)} 秒，校园网 IP 尚未就绪`);
    }

    await sleep(1000);
  }
}

/**
 * 完整登录流程。返回 { code, reason }。
 */
async function runLogin(config, options = {}) {
  log(`========== 校园网自动登录任务启动 (v${APP_VERSION}) ==========`);

  await ensureCampusNetwork(config);

  if (!options.force) {
    const status = await checkIsOnline(config);
    if (status.online) {
      log('当前设备已处于在线登录状态，无需重复登录。');
      return { code: EXIT.OK, reason: 'already-online' };
    }
    if (status.unreachable) {
      log(`在线状态检测失败（网络不可达: ${status.error || '未知'}），先不发起登录，等待链路恢复...`);
    } else {
      log('当前未登录，准备发起认证连接...');
    }
  } else {
    log('已指定 --force 参数，跳过在线检查，强制发起认证登录...');
    const preStatus = await checkIsOnline(config);
    if (preStatus.online) {
      log('注意：当前已经在线，门户不会再下发新的 queryString，--force 重登通常会失败；需要重连请先断网（或注销）再运行。');
    }
  }

  const maxRetries = config.retryCount;
  let networkFailures = 0;
  let lastError = null;
  // 重试时门户可能已认为「在线」而不再 302 到实时参数页，此时复用本次运行中
  // 上一次成功抓到的 queryString，避免误判成配置错误。
  let lastQueryString = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    log(`开始第 ${attempt}/${maxRetries} 次登录尝试...`);
    try {
      if (!networkClient.getCampusIp()) {
        log('尚未获取到校园网 IP，先等待网卡/DHCP 就绪...');
        await ensureCampusNetwork(config);
      }

      const detected = await detectQueryString(config);
      let queryString = null;
      if (detected) {
        queryString = detected.queryString;
        lastQueryString = queryString;
        log('成功捕获到实时重定向参数。');
      } else if (lastQueryString) {
        queryString = lastQueryString;
        log('本次未捕获到实时参数（门户可能已认为在线），复用上一次捕获到的参数重试。');
      } else {
        log('未捕获到实时重定向参数，使用配置文件中的预设参数。');
        queryString = config.defaultQueryString;
      }
      if (!queryString) {
        throw new ConfigError('未捕获到 queryString，且 config.json 未配置 defaultQueryString');
      }

      const login = await doLogin(config, queryString);
      log(`认证接口返回成功${login.userIndex ? `（userIndex: ${login.userIndex}）` : ''}，进行二次校验...`);

      await sleep(config.verifyAfterLoginMs);
      const verified = await checkIsOnline(config);
      if (verified.online) {
        log('二次校验通过，当前设备已在线。');
        log('========== 校园网自动登录完成 ==========');
        return { code: EXIT.OK, reason: 'logged-in' };
      }
      lastError = new Error('登录接口返回成功，但二次校验未在线（会话可能未建立）');
      log(`${lastError.message}，继续重试...`);
    } catch (err) {
      lastError = err;
      const kind = classifyError(err);
      log(`第 ${attempt} 次尝试失败[${kind}]: ${err.message}`);

      if (kind === 'config') {
        log('配置问题无法通过重试解决，退出。');
        return { code: EXIT.CONFIG_ERROR, reason: 'config' };
      }
      if (kind === 'auth') {
        log('参数或认证问题，停止重试（原因见上一条日志）。');
        return { code: EXIT.LOGIN_FAILED, reason: 'auth-rejected' };
      }
      if (kind === 'network') networkFailures += 1;
    }

    if (attempt < maxRetries) {
      const waitMs =
        classifyError(lastError) === 'network'
          ? Math.min(config.retryDelayMs * Math.pow(1.5, Math.max(0, networkFailures - 1)), 60000)
          : config.authFailureDelayMs;
      log(`等待 ${Math.round(waitMs / 1000)} 秒后进行重试...`);
      await sleep(waitMs);
    }
  }

  log(`已达到最大重试次数，未能成功登录。最后错误: ${lastError ? lastError.message : '未知'}`);
  return {
    code: networkFailures >= maxRetries ? EXIT.NETWORK_NOT_READY : EXIT.LOGIN_FAILED,
    reason: 'retry-exhausted'
  };
}

/**
 * --status：输出一行 JSON，便于脚本/外部工具读取。
 */
async function printStatus(config) {
  const iface = networkClient.getCampusInterface();
  const status = {
    version: APP_VERSION,
    time: formatTime(),
    serverHost: config.serverHost,
    adapterMatch: config.adapterMatch,
    nic: iface
      ? {
          name: iface.name,
          address: iface.address,
          mac: networkClient.macToSalt(iface.mac) || null
        }
      : null,
    ip: networkClient.getCampusIp(),
    online: false,
    unreachable: false
  };

  const statusResult = await checkIsOnline(config);
  status.online = !!statusResult.online;
  status.unreachable = !!statusResult.unreachable;
  if (statusResult.error) status.error = statusResult.error;

  console.log(JSON.stringify(status));
  return status.online ? EXIT.OK : EXIT.LOGIN_FAILED;
}

async function main(argv = process.argv.slice(2), configPath = CONFIG_PATH) {
  const options = parseArgs(argv);
  quietMode = options.quiet || process.env.CAMPUS_LOGIN_QUIET === '1';

  if (options.help) {
    printHelp();
    return EXIT.OK;
  }

  rotateLogIfNeeded();

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    log(`配置错误: ${err.message}`);
    return EXIT.CONFIG_ERROR;
  }

  if (options.status) {
    return printStatus(config);
  }

  if (!acquireLock(LOCK_PATH, config.lockStaleMs)) {
    log('已有另一个登录实例在运行，本次跳过（若确认没有实例在跑，可删除 campus_login.lock 后重试）。');
    return EXIT.OK;
  }

  try {
    const result = await runLogin(config, options);
    return result.code;
  } finally {
    releaseLock(LOCK_PATH);
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      log(`主流程异常终止: ${(err && err.stack) || err}`);
      process.exitCode = EXIT.LOGIN_FAILED;
    });
}

module.exports = {
  APP_VERSION,
  CONFIG_PATH,
  DEFAULTS,
  EXIT,
  LOG_PATH,
  LOCK_PATH,
  ConfigError,
  AuthError,
  acquireLock,
  classifyError,
  checkIsOnline,
  decryptDpapi,
  detectQueryString,
  doLogin,
  ensureCampusNetwork,
  extractMacFromQueryString,
  formatTime,
  isPidAlive,
  isPortalQueryString,
  loadConfig,
  log,
  main,
  mergeConfig,
  parseArgs,
  printStatus,
  releaseLock,
  rotateLogIfNeeded,
  runLogin,
  sleep,
  stripQueryString,
  waitForCampusIpWithRenew
};

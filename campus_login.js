// 锐捷 eportal 校园网自动登录（Windows）
//
// v1.1.1 主要变化：自动任务不再反复拉起用户手动禁用的网卡。
//   autoEnable: once（默认，每次开机最多自动启用一次）/ always（旧行为）/ never；
//   手动运行（run_now.vbs / run.bat）始终允许启用网卡。
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
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const networkClient = require('./network_client');
const { encryptPassword } = require('./rsa_util');
const nicCtl = require('./nic_ctl');

const APP_VERSION = '2.0.0';
const SCRIPT_DIR = __dirname;
const CONFIG_PATH = process.env.CAMPUS_LOGIN_CONFIG
  ? path.resolve(process.env.CAMPUS_LOGIN_CONFIG)
  : path.join(SCRIPT_DIR, 'config.json');
const LOG_PATH = process.env.CAMPUS_LOGIN_LOG
  ? path.resolve(process.env.CAMPUS_LOGIN_LOG)
  : path.join(SCRIPT_DIR, 'campus_login.log');
const LOCK_PATH = path.join(SCRIPT_DIR, 'campus_login.lock');
// 记录“本次开机是否已经自动处理过网卡”，避免用户手动禁用后被自动任务反复拉起
const STATE_PATH = process.env.CAMPUS_LOGIN_STATE
  ? path.resolve(process.env.CAMPUS_LOGIN_STATE)
  : path.join(SCRIPT_DIR, 'state.json');

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
  // 自动启用策略：once=每次开机最多自动启用一次网卡（默认，避免手动禁用被反复拉起）；
  // always=只要检测到禁用就启用（旧行为）；never=从不自动启用（等价于 manageAdapter=false）。
  autoEnable: 'once',
  // 每次开机只自动执行一次登录：计划任务重复触发/补触发时直接跳过，
  // 保证“开机后自动登录一次”，之后不再拉起用户手动禁用的网卡。
  oncePerBoot: true,
  probeUrls: [
    'http://1.1.1.1/',
    'http://connect.rom.miui.com/generate_204',
    'http://www.msftconnecttest.com/redirect'
  ],
  // 真实外网可达性探测：仅用于 `--status` 诊断（不参与登录判定）。
  internetProbes: [
    { url: 'http://www.msftconnecttest.com/connecttest.txt', contains: 'Microsoft Connect Test' },
    { url: 'http://connectivitycheck.gstatic.com/generate_204', statusCode: 204 }
  ],
  adapterMatch: nicCtl.DEFAULT_ADAPTER_MATCH,
  nicEnableWaitMs: 60000,
  retryCount: 3,
  retryDelayMs: 5000,
  requestTimeoutMs: 5000,
  logMaxBytes: 1024 * 1024,
  lockStaleMs: 5 * 60 * 1000,
  service: '',
  operatorUserId: '',
  defaultQueryString: ''
});

const AUTO_ENABLE_MODES = Object.freeze(['once', 'always', 'never']);

const NUMERIC_KEYS = [
  'portalPort',
  'nicEnableWaitMs',
  'retryCount',
  'retryDelayMs',
  'requestTimeoutMs',
  'logMaxBytes',
  'lockStaleMs'
];

let quietMode = process.env.CAMPUS_LOGIN_QUIET === '1';

// 本次运行中，是否因为「尊重用户手动禁用的选择」而没有启用网卡。
// 一旦置位，runLogin 会立即以 NETWORK_NOT_READY 退出，不再空转重试。
let adapterDisabledByUser = false;

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
  config.internetProbes =
    Array.isArray(config.internetProbes) && config.internetProbes.length > 0
      ? config.internetProbes.map((item) => (typeof item === 'string' ? { url: item } : { ...item }))
      : defaults.internetProbes.map((item) => ({ ...item }));
  for (const key of NUMERIC_KEYS) {
    const value = Number(config[key]);
    config[key] = Number.isFinite(value) && value > 0 ? value : defaults[key];
  }
  // 端口超过 65535 时回落到默认 80，其他非法的数字交给下面的校验
  if (!Number.isInteger(config.portalPort) || config.portalPort > 65535) {
    config.portalPort = defaults.portalPort;
  }
  config.manageAdapter = config.manageAdapter !== false;
  if (!AUTO_ENABLE_MODES.includes(config.autoEnable)) {
    config.autoEnable = defaults.autoEnable;
  }
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
  const options = { force: false, quiet: false, status: false, help: false, auto: false, daily: false };
  for (const arg of argv) {
    if (arg === '--force' || arg === '-f') options.force = true;
    else if (arg === '--quiet' || arg === '-q' || arg === '/quiet') options.quiet = true;
    else if (arg === '--status' || arg === '-s') options.status = true;
    else if (arg === '--auto') options.auto = true;
    else if (arg === '--daily') options.daily = true;
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
    '  --auto         自动运行模式（计划任务使用）：每次开机最多自动启用一次网卡，',
    '                 之后即使你手动禁用也不会再被拉起；手动运行不带该参数',
    '  --daily        每日 06:10 计划任务模式：同样尊重手动禁用，但不受',
    '                 “每次开机只自动登录一次”限制（用于会话过期后的每日确认）',
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

/**
 * 纯函数：根据三条探测的响应判断当前是否已在线（不同门户版本字段不一致）。
 *  1) getOnlineUserInfo 返回带 userIndex 的 JSON（不强制 result 字段）；
 *  2) redirectortosuccess.jsp 302 跳 success.jsp；
 *  3) 门户根路径 302 跳 redirectortosuccess（门户自己说「已登录」）。
 */
function interpretOnlineProbe(probe = {}) {
  const gouiBody = probe.gouiBody || '';
  const detail = {
    gouiStatus: probe.gouiStatus || 0,
    gouiLen: gouiBody.length,
    rtsStatus: probe.rtsStatus || 0,
    rootStatus: probe.rootStatus || 0
  };

  if (gouiBody) {
    try {
      const data = JSON.parse(gouiBody);
      const userIndex = data.userIndex || data.user_index;
      if (userIndex) return { online: true, userInfo: data, detail };
    } catch (err) {
      // 门户返回的可能不是 JSON，继续看重定向信号
    }
  }

  const rtsOk =
    probe.rtsStatus === 302 &&
    typeof probe.rtsLocation === 'string' &&
    probe.rtsLocation.includes('success.jsp');
  const rootOk =
    probe.rootStatus === 302 &&
    typeof probe.rootLocation === 'string' &&
    probe.rootLocation.includes('redirectortosuccess');
  if (rtsOk || rootOk) return { online: true, detail };
  return { online: false, detail };
}

/**
 * 在线判定（v1 语义）：POST getOnlineUserInfo，只有 result 为 success 且带 userIndex 才算在线。
 * v1 之所以稳定，是因为这里的判定足够严格：不会把「门户半在线」误当成已登录，
 * 也就不会出现「显示连接成功但其实没登录」的情况。
 */
async function checkIsOnline(config) {
  try {
    const res = await networkClient.request(
      {
        host: config.serverHost,
        port: config.portalPort,
        path: '/eportal/InterFace.do?method=getOnlineUserInfo',
        method: 'POST',
        timeoutMs: config.requestTimeoutMs,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
      },
      'userIndex='
    );

    let data = null;
    try {
      data = JSON.parse(res.body || '');
    } catch (err) {
      data = null;
    }
    // 门户在半在线/刚认证时会短暂返回 result:"wait"，但带 userIndex 就说明会话存在；
    // 离线时门户返回的是 {"result":"fail"}，没有 userIndex。以 userIndex 为准最稳。
    const online = Boolean(data && data.userIndex);
    return { online, statusCode: res.statusCode, userInfo: online ? data : undefined };
  } catch (err) {
    return {
      online: false,
      unreachable: networkClient.isNetworkError(err),
      error: err.message
    };
  }
}

function buildPortalUrl(config) {
  const port = Number(config.portalPort) || 80;
  return `http://${config.serverHost}${port === 80 ? '' : ':' + port}/`;
}

// 打开门户登录页时使用浏览器 UA（部分门户只对浏览器渲染完整表单）。
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BROWSER_HEADERS = Object.freeze({
  'User-Agent': BROWSER_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
});

/** 日志里用的短 URL：保留主机+路径，query 截断。 */
function shortUrl(urlString) {
  if (!urlString) return '';
  try {
    const u = new URL(urlString);
    const query = u.search ? `?${u.search.slice(1, 61)}${u.search.length > 61 ? '...' : ''}` : '';
    return `${u.host}${u.pathname}${query}`;
  } catch (err) {
    return String(urlString).slice(0, 120);
  }
}

/**
 * 实时抓取 queryString（v1 语义）：只探测配置里的重定向地址，取 302 Location 里的参数。
 * 未通过认证时访问任意 http 页面都会被门户 302 到登录页，Location 里就带实时参数。
 * 不做「门户跳转链跟随」、不解析登录页 HTML——那两种猜测会拿到无关参数
 * （例如门户跳成功页后落到 123.123.123.123），并把正常登录流程带偏。
 * @returns {Promise<{queryString:string, source:string}|null>}
 */
async function detectQueryString(config) {
  for (const probe of config.probeUrls || []) {
    let res;
    try {
      res = await networkClient.requestUrl(probe, {
        method: 'GET',
        timeoutMs: Math.min(config.requestTimeoutMs, 3000)
      });
    } catch (err) {
      log(`探测 ${probe} 失败: ${err.message}`);
      continue;
    }

    const location = (res.headers && res.headers.location) || '';
    if (!location) {
      log(`探测 ${probe}: 没有发生重定向（HTTP ${res.statusCode}），当前可能已经可以上网。`);
      continue;
    }

    const queryString = stripQueryString(location);
    if (queryString && isPortalQueryString(queryString)) {
      log(`重定向捕获成功（探测地址 ${probe}）: ${shortUrl(location)}`);
      return { queryString, source: probe };
    }
    log(`忽略非门户重定向（探测地址 ${probe}）: ${shortUrl(location)}`);
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
 * 按浏览器流程打开带实时参数的登录页：让门户建立会话（下发 JSESSIONID），
 * 之后 pageInfo 才能在「半在线」状态下正常下发公钥。
 */
async function openLoginPage(config, queryString) {
  if (!queryString) return false;
  const base = buildPortalUrl(config).replace(/\/+$/, '');
  const url = `${base}/eportal/index.jsp?${queryString}`;
  try {
    const res = await networkClient.requestUrl(url, {
      method: 'GET',
      timeoutMs: config.requestTimeoutMs,
      headers: { ...BROWSER_HEADERS }
    });
    log(`已按浏览器流程打开门户登录页（HTTP ${res.statusCode}，${(res.body || '').length} 字节）。`);
    return res.statusCode === 200;
  } catch (err) {
    log(`打开门户登录页失败（${err.message}）。`);
    return false;
  }
}

/**
 * 发起一次认证登录。
 * @returns {Promise<{ok:true, userIndex?:string, macSource:string}>}
 */
async function doLogin(config, queryString) {
  let pageInfo;
  try {
    pageInfo = await fetchPageInfo(config, queryString);
  } catch (err) {
    if (err instanceof AuthError && /pageInfo 返回空响应/.test(err.message)) {
      // 复刻浏览器：先打开带参数的登录页建立会话，再重试 pageInfo。
      // 门户「半在线」时这样就能拿到公钥并真正完成认证，而不是干等网关放行。
      log('pageInfo 返回空响应，按浏览器流程先打开登录页刷新会话，再重试获取公钥...');
      const warmed = await openLoginPage(config, queryString);
      if (warmed) {
        try {
          pageInfo = await fetchPageInfo(config, queryString);
          log('打开登录页后已获取到公钥，继续提交认证。');
        } catch (retryErr) {
          pageInfo = null;
          log(`打开登录页后仍无法获取公钥（${retryErr.message}）。`);
        }
      }
      if (!pageInfo) {
        const current = await checkIsOnline(config);
        if (current.online) return { ok: true, alreadyOnline: true, userIndex: null };
        throw err;
      }
    } else {
      throw err;
    }
  }

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

// ---------------------------------------------------------------------------
// 自动启用策略：避免“用户手动禁用后被自动任务反复拉起”
// ---------------------------------------------------------------------------

/**
 * 稳定标识当前这次开机：当前秒级时间戳 - 已开机秒数。
 * 重启后结果必然变化，可用于判断 state.json 是否属于本次开机。
 *
 * 注意：Windows 的「快速启动」（HiberbootEnabled=1）属于混合休眠+恢复，
 * 不会重置系统运行时长（os.uptime），也不会更新 LastBootUpTime，因此这个
 * 公式在快速启动的机器上无法识别“新一次开机”。真正可用的开机标识是
 * 系统日志里 Kernel-Boot 事件 27（bootmgr 每次启动都会写，包括快速启动）。
 */
function getBootId(nowMs = Date.now(), uptimeSec = os.uptime()) {
  return String(Math.round(nowMs / 1000 - uptimeSec));
}

let cachedBootMarker = null;

/**
 * 本次开机的标识。优先用 Kernel-Boot 事件 27 的时间戳（快速启动也能识别），
 * 读不到系统日志时退化为 getBootId() 的旧算法。
 */
function getBootMarker() {
  if (cachedBootMarker) return cachedBootMarker;
  if (process.env.CAMPUS_LOGIN_BOOT_ID) {
    cachedBootMarker = String(process.env.CAMPUS_LOGIN_BOOT_ID);
    return cachedBootMarker;
  }

  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const powershell = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script =
    "$e=Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Kernel-Boot';Id=27} " +
    '-MaxEvents 1 -ErrorAction SilentlyContinue; ' +
    'if($e){[string]$e.TimeCreated.ToUniversalTime().Ticks}';
  try {
    if (fs.existsSync(powershell)) {
      const result = spawnSync(
        powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { encoding: 'utf8', timeout: 8000, windowsHide: true }
      );
      const ticks = String(result.stdout || '').trim();
      if (/^\d{10,}$/.test(ticks)) {
        cachedBootMarker = `kb:${ticks}`;
        return cachedBootMarker;
      }
    }
  } catch (err) {
    // 读不到系统日志（权限/策略限制）：退化为旧算法
  }
  cachedBootMarker = `uptime:${getBootId()}`;
  return cachedBootMarker;
}

function loadState(statePath = STATE_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (raw && typeof raw === 'object') {
      return {
        bootId: typeof raw.bootId === 'string' ? raw.bootId : '',
        bootHandledAt: Number.isFinite(raw.bootHandledAt) ? raw.bootHandledAt : 0,
        enableCount: Number.isFinite(raw.enableCount) ? raw.enableCount : 0,
        lastEnableAt: Number.isFinite(raw.lastEnableAt) ? raw.lastEnableAt : 0
      };
    }
  } catch (err) {
    // 文件不存在或损坏：按空状态处理
  }
  return { bootId: '', bootHandledAt: 0, enableCount: 0, lastEnableAt: 0 };
}

function saveState(state, statePath = STATE_PATH) {
  try {
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * 自动运行是否允许启用网卡（纯函数，便于单元测试）。
 * @param {{interactive:boolean, mode:'once'|'always'|'never', adapterState:string, state:object, bootId:string}} input
 * @returns {{allow:boolean, reason:string}}
 */
function shouldAutoEnable({ interactive, mode, adapterState, state, bootId }) {
  if (mode === 'never') return { allow: false, reason: 'mode-never' };
  if (interactive) return { allow: true, reason: 'manual-run' };
  if (mode === 'always') return { allow: true, reason: 'mode-always' };
  if (adapterState === 'enabled' || adapterState === 'unknown') {
    return { allow: false, reason: 'already-enabled' };
  }
  if (adapterState === 'notfound') return { allow: false, reason: 'notfound' };
  if (adapterState === 'error') return { allow: false, reason: 'state-error' };
  const sameBoot = !!state && state.bootId === bootId;
  if (sameBoot && state.bootHandledAt > 0) return { allow: false, reason: 'boot-handled' };
  return { allow: true, reason: 'first-run-this-boot' };
}

/** 记录“本次开机已经处理过网卡”，本次开机内后续自动运行不再启用网卡。 */
function markBootHandled(config, options = {}, statePath = STATE_PATH, extra = {}) {
  if (options.interactive !== false) return false; // 手动运行不占用开机额度
  if (config.autoEnable !== 'once') return false;
  const bootId = getBootMarker();
  const previous = loadState(statePath);
  const sameBoot = previous.bootId === bootId;
  saveState(
    {
      bootId,
      bootHandledAt: Date.now(),
      enableCount: (sameBoot ? previous.enableCount : 0) + (extra.enabled ? 1 : 0),
      lastEnableAt: extra.enabled ? Date.now() : sameBoot ? previous.lastEnableAt : 0
    },
    statePath
  );
  return true;
}

function describeSkipReason(reason, config) {
  switch (reason) {
    case 'mode-never':
      return 'config.autoEnable=never，不做网卡自愈（可改为 once 或 always）';
    case 'boot-handled':
      return '本次开机已经自动处理过网卡；检测到你现在禁用了它，尊重该选择（手动运行 run_now.vbs 仍会启用，下次开机恢复自动启用）';
    case 'already-enabled':
      return '网卡本身已处于启用状态，无需自动启用';
    case 'notfound':
      return `未找到匹配「${config.adapterMatch}」的物理网卡，请检查 config.json 中的 adapterMatch`;
    case 'state-error':
      return '无法确定网卡状态，为避免误操作本次不自动启用（可运行 node nic_ctl.js --diag 排查）';
    default:
      return reason;
  }
}

/**
 * 步骤 0：确保物理网卡已启用，并等待校园网 IP 就绪。
 * options.interactive=false 表示由计划任务（--auto）触发。
 */
async function ensureCampusNetwork(config, options = {}) {
  const interactive = options.interactive !== false;

  if (config.manageAdapter === false) {
    const current = networkClient.getCampusIp();
    log(current ? `manageAdapter=false，跳过网卡自愈检查（当前 IP: ${current}）` : 'manageAdapter=false，跳过网卡自愈检查（当前未获取到校园网 IP）');
    return current;
  }

  let ip = networkClient.getCampusIp();
  if (ip) {
    log(`检测到校园网地址: ${ip}`);
    markBootHandled(config, options);
    return ip;
  }

  log('未检测到校园网地址 (172.10.x.x)，检查物理网卡是否被禁用...');

  // 先只查询状态，绝不直接启用：由 shouldAutoEnable 决定是否允许动网卡
  const bootId = getBootMarker();
  const state = loadState();
  let adapterState = 'unknown';
  let adapterName = null;
  try {
    const current = await nicCtl.getAdapterState(config.adapterMatch);
    adapterState = current.state;
    adapterName = current.adapter || null;
    if (current.state === 'error') {
      log(`查询网卡状态失败: ${current.message || '未知错误'}`);
    }
  } catch (err) {
    log(`查询网卡状态时发生异常: ${err.message}`);
  }

  const decision = shouldAutoEnable({
    interactive,
    mode: config.autoEnable,
    adapterState,
    state,
    bootId
  });

  if (!decision.allow) {
    log(`不自动启用网卡：${describeSkipReason(decision.reason, config)}`);
    if (decision.reason === 'already-enabled') {
      markBootHandled(config, options);
    } else if (adapterState === 'disabled') {
      log('网卡处于禁用状态且本次不自动启用，跳过等待 IP（需要立即上网请手动运行 run_now.vbs）。');
      adapterDisabledByUser = true;
      return null;
    }
  } else {
    try {
      const result = await nicCtl.ensureCampusAdapter(config.adapterMatch);
      adapterName = result.adapter || adapterName;
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
      if (result.action === 'enabled' || result.action === 'already') {
        markBootHandled(config, options, STATE_PATH, { enabled: result.action === 'enabled' });
      }
    } catch (err) {
      log(`启用物理网卡时发生异常: ${err.message}`);
    }
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

  const statePath = options.statePath || STATE_PATH;

  // 每次开机（自动触发）只执行一次；手动运行不受限制。
  if (options.interactive === false && !options.daily && config.oncePerBoot) {
    if (bootAutoRunHandled(statePath)) {
      log('本次开机已经自动执行过登录，跳过本次触发。');
      return { code: EXIT.OK, reason: 'once-per-boot-skipped' };
    }
  }

  await ensureCampusNetwork(config, options);
  if (adapterDisabledByUser) {
    log('网卡被用户禁用且本次不自动启用，跳过登录（需要立即上网请手动运行 run_now.vbs）。');
    return { code: EXIT.NETWORK_NOT_READY, reason: 'adapter-disabled-by-user' };
  }

  if (options.interactive === false && !options.daily && config.oncePerBoot) {
    markBootRun(statePath);
  }

  // 1) 在线检查（v1 语义），已在线直接结束。
  if (!options.force) {
    const status = await checkIsOnline(config);
    if (status.online) {
      log('当前设备已处于在线登录状态，无需重复登录。');
      markBootHandled(config, options, STATE_PATH);
      log('========== 校园网自动登录完成 ==========');
      return { code: EXIT.OK, reason: 'already-online' };
    }
    if (status.unreachable) {
      log(`在线状态检测失败（网络不可达: ${status.error || '未知错误'}），继续尝试登录...`);
    } else {
      log('当前未登录，准备发起认证连接...');
    }
  } else {
    log('已指定 --force 参数，跳过在线检查，强制发起认证登录...');
  }

  // 2) 抓实时 queryString（v1 语义）；抓不到就用配置里的预设参数。
  let queryString = config.defaultQueryString || '';
  const detected = await detectQueryString(config);
  if (detected && detected.queryString) {
    queryString = detected.queryString;
  } else if (queryString) {
    log('未捕获到实时重定向参数，使用配置文件中的预设参数。');
  }

  if (!queryString) {
    log('未能获取到登录参数，请检查网络连接或 config.json 中的 defaultQueryString。');
    return { code: EXIT.CONFIG_ERROR, reason: 'missing-query-string' };
  }

  // 3) 登录重试（v1 语义：连续重试，认证错误不空转）。
  const maxRetries = config.retryCount || 3;
  const retryDelay = config.retryDelayMs || 5000;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    log(`开始第 ${attempt}/${maxRetries} 次登录尝试...`);
    try {
      const result = await doLogin(config, queryString);
      if (result.ok) {
        if (result.alreadyOnline) {
          log('门户确认当前设备已在线，无需重复登录。');
        } else {
          // v1.1 起保留的一次轻量校验：登录接口返回成功后再问一次门户是否真的在线。
          await sleep(config.verifyAfterLoginMs || 1500);
          const after = await checkIsOnline(config);
          if (!after.online) {
            throw new Error('二次校验失败：登录接口返回成功，但门户仍显示未登录');
          }
          log('二次校验通过：门户已显示在线。');
        }
        markBootHandled(config, options, STATE_PATH);
        log('========== 校园网自动登录完成 ==========');
        return { code: EXIT.OK, reason: result.alreadyOnline ? 'already-online' : 'login-ok' };
      }
    } catch (err) {
      const kind = classifyError(err);
      log(`第 ${attempt} 次尝试失败[${kind}]: ${err.message}`);
      if (kind === 'config') {
        return { code: EXIT.CONFIG_ERROR, reason: 'config-error' };
      }
      if (kind === 'auth') {
        log('参数或认证问题，停止重试（原因见上一条日志）。');
        return { code: EXIT.LOGIN_FAILED, reason: 'auth-failed' };
      }
    }

    if (attempt < maxRetries) {
      log(`等待 ${Math.round(retryDelay / 1000)} 秒后进行重试...`);
      await sleep(retryDelay);
    }
  }

  log(`已达到最大重试次数（${maxRetries} 次），未能成功登录。`);
  return { code: EXIT.LOGIN_FAILED, reason: 'login-failed' };
}

/**
 * 本次开机是否已经执行过自动登录（“每次开机只跑一次”）。
 */
function bootAutoRunHandled(statePath = STATE_PATH) {
  const state = loadState(statePath);
  return state.bootId === getBootMarker() && state.bootHandledAt > 0;
}

/**
 * 占用本次开机的自动执行额度（重复触发直接跳过）。
 */
function markBootRun(statePath = STATE_PATH) {
  const bootId = getBootMarker();
  const previous = loadState(statePath);
  const sameBoot = previous.bootId === bootId;
  saveState(
    {
      bootId,
      bootHandledAt: Date.now(),
      enableCount: sameBoot ? previous.enableCount : 0,
      lastEnableAt: sameBoot ? previous.lastEnableAt : 0
    },
    statePath
  );
  return true;
}

/**
 * 真实外网可达性校验：门户说“在线”不代表真能上网，避免误报“连接成功”。
 * 返回 { ok, detail }；未配置探测地址时视为通过（兼容测试/离线环境）。
 */
async function checkInternetAccess(config) {
  const probes = Array.isArray(config.internetProbes) ? config.internetProbes : [];
  if (probes.length === 0) return { ok: true, detail: '未配置外网探测地址，跳过校验' };
  const failures = [];
  for (const probe of probes) {
    const target = typeof probe === 'string' ? { url: probe } : probe || {};
    if (!target.url) continue;
    try {
      const res = await networkClient.requestUrl(target.url, {
        timeoutMs: Math.min(config.requestTimeoutMs || 5000, 5000)
      });
      const status = res.statusCode;
      const body = res.body || '';
      if (target.statusCode) {
        if (status === target.statusCode) return { ok: true, detail: `${target.url} → HTTP ${status}` };
        failures.push(`${target.url} → HTTP ${status}（期望 ${target.statusCode}）`);
        continue;
      }
      const expected = target.contains || 'Microsoft Connect Test';
      if (status === 200 && body.includes(expected)) {
        return { ok: true, detail: `${target.url} → HTTP 200 且内容正常` };
      }
      failures.push(
        `${target.url} → HTTP ${status}${body ? '（返回内容不是预期页面，可能被门户劫持）' : ''}`
      );
    } catch (err) {
      failures.push(`${target.url} → ${err.code || err.message}`);
    }
  }
  return { ok: false, detail: failures.join('；') || '所有探测地址均失败' };
}

// 「门户假在线」等待恢复的结果，供 runLogin 判断下一步
let staleSessionRecovered = false;
let staleSessionNeedsRelogin = false;

/**
 * --status：输出一行 JSON，便于脚本/外部工具读取。
 */
async function printStatus(config) {
  const iface = networkClient.getCampusInterface();
  let adapter = null;
  try {
    adapter = await nicCtl.getAdapterState(config.adapterMatch);
  } catch (err) {
    adapter = null;
  }
  const status = {
    version: APP_VERSION,
    time: formatTime(),
    serverHost: config.serverHost,
    adapterMatch: config.adapterMatch,
    autoEnable: config.autoEnable,
    nic: {
      name: (adapter && adapter.adapter) || (iface && iface.name) || null,
      state: adapter ? adapter.state : 'unknown',
      status: adapter ? adapter.status || null : null,
      // 只有网卡身份与状态里的网卡一致时才展示地址，避免误显示虚拟网卡
      address: iface && adapter && iface.name === adapter.adapter ? iface.address : null,
      mac:
        iface && adapter && iface.name === adapter.adapter
          ? networkClient.macToSalt(iface.mac) || null
          : null
    },
    ip: networkClient.getCampusIp(),
    online: false,
    unreachable: false
  };

  const statusResult = await checkIsOnline(config);
  status.online = !!statusResult.online;
  status.unreachable = !!statusResult.unreachable;
  if (statusResult.error) status.error = statusResult.error;

  if (status.online) {
    const internet = await checkInternetAccess(config);
    status.internet = !!internet.ok;
    if (!internet.ok) status.internetDetail = internet.detail;
  } else {
    status.internet = false;
  }

  console.log(JSON.stringify(status));
  return status.online && status.internet ? EXIT.OK : EXIT.LOGIN_FAILED;
}

async function main(argv = process.argv.slice(2), configPath = CONFIG_PATH) {
  const options = parseArgs(argv);
  // --auto = 计划任务触发；--daily = 每日 06:10 任务（同样不算“手动运行”）。
  // 两者都不允许绕过网卡手动禁用的保护；不带这两个参数视为用户手动运行，允许主动启用网卡。
  options.interactive = !options.auto && !options.daily;
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
  AUTO_ENABLE_MODES,
  CONFIG_PATH,
  DEFAULTS,
  EXIT,
  LOG_PATH,
  LOCK_PATH,
  STATE_PATH,
  ConfigError,
  AuthError,
  acquireLock,
  bootAutoRunHandled,
  checkInternetAccess,
  classifyError,
  checkIsOnline,
  decryptDpapi,
  describeSkipReason,
  detectQueryString,
  doLogin,
  ensureCampusNetwork,
  extractMacFromQueryString,
  formatTime,
  getBootId,
  getBootMarker,
  isPidAlive,
  interpretOnlineProbe,
  isPortalQueryString,
  loadConfig,
  loadState,
  log,
  main,
  markBootHandled,
  markBootRun,
  mergeConfig,
  parseArgs,
  printStatus,
  releaseLock,
  rotateLogIfNeeded,
  runLogin,
  saveState,
  shouldAutoEnable,
  sleep,
  stripQueryString,
  waitForCampusIpWithRenew
};

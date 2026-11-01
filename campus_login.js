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

const APP_VERSION = '1.1.6';
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
  // 真实外网可达性探测：门户说“在线”不等于真能上网，用于防止误报成功。
  internetProbes: [
    { url: 'http://www.msftconnecttest.com/connecttest.txt', contains: 'Microsoft Connect Test' },
    { url: 'http://connectivitycheck.gstatic.com/generate_204', statusCode: 204 }
  ],
  adapterMatch: nicCtl.DEFAULT_ADAPTER_MATCH,
  nicEnableWaitMs: 60000,
  retryCount: 3,
  retryDelayMs: 15000,
  authFailureDelayMs: 3000,
  requestTimeoutMs: 5000,
  verifyAfterLoginMs: 1500,
  // 门户“假在线”（门户说在线但外网被拦截）时的复查策略：
  // 每次等待 internetRetryDelayMs 后再复查，最多复查 internetRetryCount 次。
  // 校园网开机后网关放行常需要几十秒，等一会儿通常会自动恢复。
  internetRetryCount: 8,
  internetRetryDelayMs: 15000,
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
  'authFailureDelayMs',
  'requestTimeoutMs',
  'verifyAfterLoginMs',
  'internetRetryCount',
  'internetRetryDelayMs',
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

async function checkIsOnline(config) {
  const common = {
    host: config.serverHost,
    port: config.portalPort,
    timeoutMs: config.requestTimeoutMs
  };

  const probe = {};
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
    probe.gouiStatus = res.statusCode;
    probe.gouiBody = res.body || '';
  } catch (err) {
    return {
      online: false,
      unreachable: networkClient.isNetworkError(err),
      error: err.message,
      detail: { step: 'getOnlineUserInfo' }
    };
  }

  try {
    const redirect = await networkClient.request({
      ...common,
      path: '/eportal/redirectortosuccess.jsp',
      method: 'GET'
    });
    probe.rtsStatus = redirect.statusCode;
    probe.rtsLocation = redirect.headers && redirect.headers.location;
  } catch (err) {
    probe.rtsStatus = 0;
  }

  try {
    const root = await networkClient.request({ ...common, path: '/', method: 'GET' });
    probe.rootStatus = root.statusCode;
    probe.rootLocation = root.headers && root.headers.location;
  } catch (err) {
    probe.rootStatus = 0;
  }

  return interpretOnlineProbe(probe);
}

/**
 * 实时抓取 queryString：先打门户网关（必然 302），再依次尝试配置的探测地址。
 * @returns {Promise<{queryString:string, source:string}|null>}
 */
function buildPortalUrl(config) {
  const port = Number(config.portalPort) || 80;
  return `http://${config.serverHost}${port === 80 ? '' : ':' + port}/`;
}

// 门户的浏览器流程是：GET / → 302 redirectortosuccess.jsp → 302 index.jsp?<实时参数>。
// 只请求第一跳会漏掉真正的参数页（刚开机「半在线」时尤其明显），所以要跟完整跳转链。
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BROWSER_HEADERS = Object.freeze({
  'User-Agent': BROWSER_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
});

/** 把 Location 相对路径解析成绝对 URL，失败返回 null。 */
function resolveUrl(baseUrl, location) {
  try {
    return new URL(location, baseUrl).toString();
  } catch (err) {
    return null;
  }
}

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

/** 从登录页 HTML 兜底提取 queryString（有的门户把参数写在隐藏表单里）。 */
function extractQueryStringFromHtml(html) {
  if (!html) return null;
  const patterns = [
    /name=["']queryString["'][^>]*value=["']([^"']+)["']/i,
    /value=["']([^"']*wlanuserip=[^"']*)["']/i,
    /(wlanuserip=[0-9a-zA-Z._%-]+(?:&[^"'\s<>]*)?)/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (!match) continue;
    let value = match[1];
    try {
      value = decodeURIComponent(value);
    } catch (err) {
      // 保留原值
    }
    if (isPortalQueryString(value)) return value;
  }
  return null;
}

/**
 * 跟随门户跳转链（最多 6 跳），从任意一跳的 Location 或登录页 HTML 里取实时参数。
 * 典型链：/ → redirectortosuccess.jsp → index.jsp?wlanuserip=...&mac=...
 * 真正在线时链会落到 success.jsp?userIndex=...，此时没有认证参数。
 */
async function followPortalChain(startUrl, config, maxHops = 6) {
  let currentUrl = startUrl;
  const hops = [];
  for (let hop = 0; hop < maxHops; hop += 1) {
    let res;
    try {
      res = await networkClient.requestUrl(currentUrl, {
        method: 'GET',
        timeoutMs: Math.min(config.requestTimeoutMs, 5000),
        headers: { ...BROWSER_HEADERS }
      });
    } catch (err) {
      return { hops, error: err };
    }
    const location = (res.headers && res.headers.location) || '';
    hops.push({ url: currentUrl, status: res.statusCode, location });

    const queryString = stripQueryString(location);
    if (queryString && isPortalQueryString(queryString)) {
      return { hops, queryString, sourceUrl: location };
    }
    if (!location) {
      const fromHtml = extractQueryStringFromHtml(res.body || '');
      return { hops, queryString: fromHtml, sourceUrl: currentUrl };
    }
    if (/success\.jsp/i.test(location) && !/redirectortosuccess/i.test(location)) {
      // 门户自己的成功页：说明此刻已在线，这里没有新的认证参数
      return { hops, online: true, sourceUrl: location };
    }
    if (queryString) {
      return { hops, nonPortal: true, sourceUrl: location };
    }
    const nextUrl = resolveUrl(currentUrl, location);
    if (!nextUrl) return { hops, nonPortal: true, sourceUrl: location };
    currentUrl = nextUrl;
  }
  return { hops };
}

/**
 * 实时抓取 queryString：先跟门户网关的跳转链（浏览器同款），再依次尝试配置的探测地址。
 * @returns {Promise<{queryString:string, source:string}|null>}
 */
async function detectQueryString(config) {
  const candidates = [{ label: `门户网关 ${config.serverHost}`, url: buildPortalUrl(config) }];
  for (const probe of config.probeUrls || []) {
    candidates.push({ label: `探测地址 ${probe}`, url: probe });
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const chain = await followPortalChain(candidate.url, config, 6);
    const hops = chain.hops || [];
    const chainText = hops
      .map((hop) => `${hop.status}${hop.location ? ` → ${shortUrl(hop.location)}` : ''}`)
      .join(' | ');

    if (chain.queryString) {
      log(`实时参数捕获成功（${candidate.label}）: ${shortUrl(chain.sourceUrl || '')}`);
      if (hops.length > 1) log(`跳转链: ${chainText}`);
      return { queryString: chain.queryString, source: candidate.label };
    }
    if (hops.length > 0) log(`探测链（${candidate.label}）: ${chainText}`);
    if (chain.error) {
      log(`探测 ${candidate.label} 失败: ${chain.error.message}`);
    } else if (chain.online) {
      log('门户跳转到了成功页（redirectortosuccess → success.jsp），当前已在线，没有新的认证参数。');
      return null;
    } else if (chain.nonPortal) {
      log(`忽略非门户重定向（${candidate.label}）: ${chain.sourceUrl || ''}`);
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

  // 「每次开机只执行一次」：计划任务触发的自动模式，本次开机已经跑过就直接退出，
  // 避免重复触发把用户手动禁用的网卡重新拉起。
  // 例外：--daily（每天 06:10 的会话确认）不受“每次开机只跑一次”限制。
  if (options.interactive === false && !options.daily && config.oncePerBoot) {
    if (bootAutoRunHandled()) {
      log('本次开机已经自动执行过登录，跳过本次触发（每次开机只自动执行一次）。');
      return { code: EXIT.OK, reason: 'already-run-this-boot' };
    }
    markBootRun();
  }

  await ensureCampusNetwork(config, options);

  // 用户手动禁用了网卡，而本次是计划任务（--auto）且开机额度已用过：
  // 尊重用户选择，直接以「网络未就绪」退出，不做无意义的重试。
  if (adapterDisabledByUser) {
    log('网卡被用户禁用且本次不自动启用，跳过登录（需要立即上网请手动运行 run_now.vbs）。');
    log('========== 校园网自动登录结束（网络未就绪） ==========');
    return { code: EXIT.NETWORK_NOT_READY, reason: 'adapter-disabled-by-user' };
  }

  if (!options.force) {
    const status = await checkIsOnline(config);
    if (status.online) {
      const internet = await checkInternetAccess(config);
      if (internet.ok) {
        log(`当前设备已处于在线登录状态，且外网可达（${internet.detail}），无需重复登录。`);
        return { code: EXIT.OK, reason: 'already-online' };
      }
      // 门户假在线（数据面被拦截）在校园网刚开机时很常见：先注销/等待，再决定是重登还是退出。
      log(
        `门户报告已在线，但外网不可达（${internet.detail}）——可能是认证网关尚未放行或会话残留，先等待并复查...`
      );
      await recoverFromStalePortalSession(config, status, options);
      if (staleSessionRecovered) {
        log('========== 校园网自动登录完成（等待后外网已恢复） ==========');
        return { code: EXIT.OK, reason: 'already-online-recovered' };
      }
      if (!staleSessionNeedsRelogin) {
        return { code: EXIT.NETWORK_NOT_READY, reason: 'portal-stale-session' };
      }
    }
    if (status.unreachable) {
      log(`在线状态检测失败（网络不可达: ${status.error || '未知'}），先不发起登录，等待链路恢复...`);
    } else {
      const d = status.detail || {};
      log(
        `在线探测明细：getOnlineUserInfo=${d.gouiStatus || '-'}(${d.gouiLen || 0} 字节)，redirectortosuccess=${d.rtsStatus || '-'}，门户根路径=${d.rootStatus || '-'}`
      );
      log('当前未登录，准备发起认证连接...');
    }
  } else {
    log('已指定 --force 参数，跳过在线检查，强制发起认证登录...');
    const preStatus = await checkIsOnline(config);
    if (preStatus.online) {
      const preInternet = await checkInternetAccess(config);
      if (!preInternet.ok) {
        log(`--force 前检测到门户在线但外网不可达（${preInternet.detail}），先尝试注销/等待恢复...`);
        await recoverFromStalePortalSession(config, preStatus, options);
        if (staleSessionRecovered) {
          log('========== 校园网自动登录完成（等待后外网已恢复） ==========');
          return { code: EXIT.OK, reason: 'already-online-recovered' };
        }
      } else {
        log(
          '注意：当前已经在线且外网可达，门户不会再下发新的 queryString，--force 重登通常会失败；需要重连请先断网（或注销）再运行。'
        );
      }
    }
  }

  const maxRetries = config.retryCount;
  let networkFailures = 0;
  let lastError = null;
  // 本次尝试是否属于「门户说在线但外网被拦截」这种瞬时状态（按网络类失败退避重试）
  let transientNoInternet = false;
  // 重试时门户可能已认为「在线」而不再 302 到实时参数页，此时复用本次运行中
  // 上一次成功抓到的 queryString，避免误判成配置错误。
  let lastQueryString = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    log(`开始第 ${attempt}/${maxRetries} 次登录尝试...`);
    transientNoInternet = false;
    try {
      if (!networkClient.getCampusIp()) {
        log('尚未获取到校园网 IP，先等待网卡/DHCP 就绪...');
        await ensureCampusNetwork(config, options);
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
      if (login.alreadyOnline) {
        // 门户认为已在线，确认外网是否真的可通；刚开机时网关可能还没放行，等一小会儿再判定。
        let internet = await checkInternetAccess(config);
        if (!internet.ok) {
          internet = await waitForInternetRecovery(config, {
            attempts: 2,
            intervalMs: config.internetRetryDelayMs
          });
        }
        if (!internet.ok) {
          lastError = new Error(`门户认为已在线，但外网不可达（${internet.detail}）`);
          networkFailures += 1;
          transientNoInternet = true;
          log(`${lastError.message}，判定为未真正联网，稍后重试...`);
        } else {
          log(`门户已确认当前设备在线，且外网可达（${internet.detail}），无需重复登录。`);
          markBootHandled(config, options);
          log('========== 校园网自动登录完成 ==========');
          return { code: EXIT.OK, reason: 'already-online' };
        }
      } else {
        log(`认证接口返回成功${login.userIndex ? `（userIndex: ${login.userIndex}）` : ''}，进行二次校验...`);

        await sleep(config.verifyAfterLoginMs);
        const verified = await checkIsOnline(config);
        if (verified.online) {
          let internet = await checkInternetAccess(config);
          if (!internet.ok) {
            internet = await waitForInternetRecovery(config, {
              attempts: 2,
              intervalMs: config.internetRetryDelayMs
            });
          }
          if (internet.ok) {
            log(`二次校验通过，当前设备已在线且外网可达（${internet.detail}）。`);
            markBootHandled(config, options);
            log('========== 校园网自动登录完成 ==========');
            return { code: EXIT.OK, reason: 'logged-in' };
          }
          lastError = new Error(`门户显示已在线，但外网不可达（${internet.detail}）`);
          networkFailures += 1;
          transientNoInternet = true;
          log(`${lastError.message}，本次不算登录成功，稍后重试...`);
        } else {
          lastError = new Error('登录接口返回成功，但二次校验未在线（会话可能未建立）');
          log(`${lastError.message}，继续重试...`);
        }
      }
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
      const treatAsNetwork = transientNoInternet || classifyError(lastError) === 'network';
      const waitMs = treatAsNetwork
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

/**
 * 门户认为「在线」但外网实际被拦截时，等待数据面恢复：
 * 每 intervalMs 复查一次外网，最多 attempts 次，恢复即返回成功。
 */
async function waitForInternetRecovery(config, { attempts = 2, intervalMs = 15000 } = {}) {
  let last = await checkInternetAccess(config);
  const total = Math.max(1, attempts);
  for (let i = 1; i <= total && !last.ok; i += 1) {
    if (i === total) break;
    await sleep(intervalMs);
    last = await checkInternetAccess(config);
    if (!last.ok) log(`外网仍不可达，稍后继续复查（第 ${i}/${total - 1} 次）...`);
  }
  return last;
}

/**
 * 请求门户注销当前会话（best effort）：部分「假在线」状态需要先注销，
 * 门户才会在下次跳转时重新下发实时认证参数。
 * 门户接口：POST /eportal/InterFace.do?method=logout，body userIndex=<...>。
 * 注意：部分校园网开了 MAB（MAC 免认证），注销后可能被立即重新认证，属正常现象。
 */
async function logoutPortal(config, userIndex) {
  const body = `userIndex=${encodeURIComponent(userIndex || '')}`;
  const res = await networkClient.request(
    {
      host: config.serverHost,
      port: config.portalPort,
      timeoutMs: config.requestTimeoutMs,
      path: '/eportal/InterFace.do?method=logout',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
    },
    body
  );
  let parsed = null;
  try {
    parsed = JSON.parse(res.body || '{}');
  } catch (err) {
    parsed = null;
  }
  return {
    ok: !!(parsed && parsed.result === 'success'),
    status: res.statusCode,
    message: (parsed && parsed.message) || String(res.body || '').slice(0, 80) || '接口无返回内容'
  };
}

// 「门户假在线」等待恢复的结果，供 runLogin 判断下一步
let staleSessionRecovered = false;
let staleSessionNeedsRelogin = false;

/**
 * 处理「门户说在线、外网不可达」：先尝试注销会话，再按 internetRetryCount 耐心等待数据面放行。
 * - 外网恢复：置 staleSessionRecovered=true
 * - 门户转为未登录：置 staleSessionNeedsRelogin=true（可重新抓参数认证）
 * - 一直卡住：两者都为 false，由调用方返回退出码 2
 */
async function recoverFromStalePortalSession(config, status, options = {}) {
  staleSessionRecovered = false;
  staleSessionNeedsRelogin = false;
  const userIndex = (status && status.userInfo && status.userInfo.userIndex) || '';
  try {
    const logout = await logoutPortal(config, userIndex);
    if (logout.ok) {
      log(`已请求门户注销当前会话（${logout.message}），等待门户重新分配认证状态...`);
    } else {
      log(`门户注销请求未生效（${logout.message}），改为等待数据面恢复...`);
    }
  } catch (err) {
    log(`门户注销请求异常（${err.message}），改为等待数据面恢复...`);
  }
  await sleep(Math.min(1500, Math.max(200, Number(config.internetRetryDelayMs) || 15000)));

  // 计划任务（--auto/--daily）在开机时更耐心：默认最多等约 3 分钟；
  // 手动运行按配置值（默认 8 × 15 秒 ≈ 2 分钟），避免双击后等太久。
  const configured = Math.max(1, Number(config.internetRetryCount) || 8);
  const attempts = options.interactive === false ? Math.max(configured, 12) : configured;
  const intervalMs = Math.max(200, Number(config.internetRetryDelayMs) || 15000);
  for (let i = 1; i <= attempts; i += 1) {
    const online = await checkIsOnline(config);
    if (!online.online) {
      staleSessionNeedsRelogin = true;
      log(`第 ${i}/${attempts} 次复查：门户已不再认为本机在线，可以重新抓取参数认证。`);
      return;
    }

    // 不干等网关放行：像浏览器一样再抓一次实时参数，抓到就主动重新认证。
    const detected = await detectQueryString(config);
    if (detected && detected.queryString) {
      log(`第 ${i}/${attempts} 次复查：抓到实时参数，主动重新认证一次...`);
      try {
        const login = await doLogin(config, detected.queryString);
        if (login.ok && !login.alreadyOnline) {
          await sleep(Math.min(2000, Math.max(200, Number(config.verifyAfterLoginMs) || 1500)));
          const after = await checkInternetAccess(config);
          if (after.ok) {
            staleSessionRecovered = true;
            markBootHandled(config, options);
            log(`第 ${i}/${attempts} 次复查：重新认证后外网已恢复可达（${after.detail}）。`);
            return;
          }
          log(`第 ${i}/${attempts} 次复查：重新认证成功，但外网仍不可达，继续尝试...`);
        } else if (login.alreadyOnline) {
          log(`第 ${i}/${attempts} 次复查：门户仍认为本机在线且未下发新参数，继续等待数据面放行...`);
        } else {
          log(`第 ${i}/${attempts} 次复查：重新认证未成功（${login.message || '未知原因'}），继续等待...`);
        }
      } catch (err) {
        log(`第 ${i}/${attempts} 次复查：主动重新认证失败（${err.message}），继续等待...`);
      }
    } else {
      log(`第 ${i}/${attempts} 次复查：暂时抓不到实时参数（门户仍认为在线），继续等待数据面放行...`);
    }

    const internet = await checkInternetAccess(config);
    if (internet.ok) {
      staleSessionRecovered = true;
      markBootHandled(config, options);
      log(`第 ${i}/${attempts} 次复查：外网已恢复可达（${internet.detail}）。`);
      return;
    }
    if (i < attempts) {
      log(`第 ${i}/${attempts} 次复查：外网仍不可达，${Math.round(intervalMs / 1000)} 秒后继续...`);
      await sleep(intervalMs);
    }
  }
  log(
    `已复查 ${attempts} 次外网仍不可达：门户会话可能卡在认证网关侧（常见于刚开机、网关尚未放行），稍后重新运行即可。`
  );
}

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
  logoutPortal,
  recoverFromStalePortalSession,
  waitForCampusIpWithRenew,
  waitForInternetRecovery
};

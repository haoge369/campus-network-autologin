// 校园网 HTTP 请求模块
//
// 设计要点（v1.1.0 起）：
//   1. 只把请求绑定到校园网网卡（172.10.x.x）上。Windows 默认选路经常选到
//      WLAN / Clash TUN(198.18.x.x) / VirtualBox 等虚拟网卡，导致
//      connect ENETUNREACH / EADDRNOTAVAIL —— 这是历史日志里最常见的失败原因。
//   2. 拿不到校园网 IP 时不绑定源地址，交给系统路由，避免绑到错误网卡。
//   3. 绑定后的请求若报"无路由/地址不可用"，自动去绑定重试一次。
'use strict';

const http = require('http');
const os = require('os');
const { URL } = require('url');

const CAMPUS_PREFIX = '172.10.';
const EXCLUDED_PREFIXES = ['198.18.', '169.254.', '127.'];

// 与"绑定源地址"相关的错误，值得去掉 localAddress 重试一次
const BINDING_ERROR_CODES = new Set(['EADDRNOTAVAIL', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN']);

// 判定为"网络不可达"类错误（区别于认证失败）
const NETWORK_ERROR_CODES = new Set([
  'EADDRNOTAVAIL',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND'
]);

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * 把 os.networkInterfaces() 的结果拍平成数组。
 * @returns {Array<{name:string,address:string,family:string,mac:string,internal:boolean,cidr:string|null}>}
 */
function listInterfaces() {
  const result = [];
  const all = os.networkInterfaces();
  for (const name of Object.keys(all)) {
    for (const net of all[name] || []) {
      result.push({
        name,
        address: net.address,
        family: net.family,
        mac: net.mac,
        internal: !!net.internal,
        cidr: net.cidr || null
      });
    }
  }
  return result;
}

function isExcludedAddress(address) {
  return EXCLUDED_PREFIXES.some((p) => address.startsWith(p));
}

/**
 * 纯函数：从网卡列表中挑选校园网网卡（优先 172.10.*，其次任意可用网卡）。
 * 便于单元测试，不依赖真实网卡。
 */
function pickCampusInterface(interfaces) {
  const usable = (interfaces || []).filter(
    (net) =>
      net &&
      net.family !== 'IPv6' &&
      net.internal !== true &&
      typeof net.address === 'string' &&
      !isExcludedAddress(net.address)
  );
  if (usable.length === 0) return null;
  return usable.find((net) => net.address.startsWith(CAMPUS_PREFIX)) || usable[0];
}

/** 当前的校园网网卡对象（没有则返回 null）。 */
function getCampusInterface() {
  return pickCampusInterface(listInterfaces());
}

/** 校园网 IP（严格 172.10.x.x），拿不到返回 null。 */
function getCampusIp() {
  const net = getCampusInterface();
  if (!net) return null;
  return net.address.startsWith(CAMPUS_PREFIX) ? net.address : null;
}

/**
 * 兼容旧接口：优先返回校园网 IP，没有则回退到任意可用网卡地址。
 * 新代码请用 getCampusIp()，避免绑到 WLAN / 虚拟网卡上。
 */
function getCampusLocalIp() {
  const net = getCampusInterface();
  return net ? net.address : null;
}

/**
 * MAC 地址转成锐捷加密用的盐（去掉分隔符，统一小写）。
 * 例如 "D8-BB-C1-A1-B2-C3" -> "d8bbc1a1b2c3"
 */
function macToSalt(mac) {
  return String(mac || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
}

/** 当前校园网网卡的 MAC（作为加密盐），拿不到返回 null。 */
function getCampusMac() {
  const net = getCampusInterface();
  if (!net || !net.mac) return null;
  const salt = macToSalt(net.mac);
  return salt.length >= 6 ? salt : null;
}

function isBindingError(err) {
  return !!err && BINDING_ERROR_CODES.has(err.code);
}

function isNetworkError(err) {
  if (!err) return false;
  if (err.code && NETWORK_ERROR_CODES.has(err.code)) return true;
  // Node 的 DNS / socket 错误有时只有 message
  return /ENETUNREACH|EHOSTUNREACH|EADDRNOTAVAIL|ETIMEDOUT|ECONNRESET|EHOSTDOWN|socket hang up/i.test(
    String(err.message || '')
  );
}

/**
 * 发一次请求（不做绑定重试）。
 * @param {{host:string,port?:number,path?:string,method?:string,headers?:object,timeoutMs?:number,localAddress?:string}} options
 * @param {string|Buffer|null} body
 * @returns {Promise<{statusCode:number,headers:object,body:string}>}
 */
function sendOnce(options, body = null) {
  const host = options.host;
  const port = options.port || 80;
  const reqPath = options.path || '/';
  const method = options.method || 'GET';
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const reqOptions = {
      host,
      port,
      path: reqPath,
      method,
      headers: { ...(options.headers || {}) }
    };
    if (options.localAddress) reqOptions.localAddress = options.localAddress;
    if (body !== null && body !== undefined) {
      reqOptions.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      const err = new Error(`请求超时 (${host}:${port}${reqPath}，${timeoutMs}ms)`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });

    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * 带"校园网网卡绑定 + 自动去绑定重试"的请求。
 * 显式传入 localAddress（含 null）时以传入值为准。
 */
async function request(options, postData = null) {
  const hasExplicit = Object.prototype.hasOwnProperty.call(options, 'localAddress');
  const bindIp = hasExplicit ? options.localAddress : getCampusIp();

  const opts = { ...options };
  if (bindIp) opts.localAddress = bindIp;
  else delete opts.localAddress;

  try {
    return await sendOnce(opts, postData);
  } catch (err) {
    if (bindIp && isBindingError(err)) {
      // 绑定的网卡此刻没有可用路由：去掉绑定，让系统自己选路再试一次
      const retryOpts = { ...options };
      delete retryOpts.localAddress;
      return sendOnce(retryOpts, postData);
    }
    throw err;
  }
}

/**
 * 用完整 URL 发请求（只支持 http，用于探测 302 重定向）。
 */
async function requestUrl(urlString, options = {}, body = null) {
  const u = new URL(urlString);
  if (u.protocol !== 'http:') {
    throw new Error(`只支持 http:// 探测地址，收到: ${urlString}`);
  }
  const opts = {
    host: u.hostname,
    port: u.port ? Number(u.port) : 80,
    path: `${u.pathname || '/'}${u.search || ''}`,
    method: options.method || 'GET',
    headers: options.headers || {},
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS
  };
  if (Object.prototype.hasOwnProperty.call(options, 'localAddress')) {
    opts.localAddress = options.localAddress;
  }
  return request(opts, body);
}

module.exports = {
  CAMPUS_PREFIX,
  DEFAULT_TIMEOUT_MS,
  listInterfaces,
  pickCampusInterface,
  getCampusInterface,
  getCampusIp,
  getCampusLocalIp,
  getCampusMac,
  macToSalt,
  isBindingError,
  isNetworkError,
  sendOnce,
  request,
  requestUrl
};

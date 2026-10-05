const fs = require('fs');
const path = require('path');
const { getCampusLocalIp, request } = require('./network_client');
const { encryptPassword } = require('./rsa_util');

// 读取配置
const configPath = path.join(__dirname, 'config.json');
const logPath = path.join(__dirname, 'campus_login.log');

function log(message) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const line = `[${now}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(logPath, line + '\n', 'utf-8');
  } catch (err) {
    // 忽略日志文件写入异常
  }
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    throw new Error(`找不到配置文件: ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

/**
 * 检查当前是否已在线
 */
async function checkIsOnline(serverHost) {
  try {
    const res = await request({
      host: serverHost,
      port: 80,
      path: '/eportal/InterFace.do?method=getOnlineUserInfo',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
      }
    }, 'userIndex=');

    if (res.body) {
      try {
        const data = JSON.parse(res.body);
        if (data.result === 'success' && data.userIndex) {
          return { isOnline: true, userInfo: data };
        }
      } catch (e) {
        // 返回可能非 JSON
      }
    }

    // 备用检查：请求 redirectortosuccess.jsp
    const redirectRes = await request({
      host: serverHost,
      port: 80,
      path: '/eportal/redirectortosuccess.jsp',
      method: 'GET'
    });

    if (redirectRes.statusCode === 302 && redirectRes.headers.location && redirectRes.headers.location.includes('success.jsp')) {
      return { isOnline: true };
    }
  } catch (err) {
    log(`检测在线状态异常: ${err.message}`);
  }

  return { isOnline: false };
}

/**
 * 尝试自动探测当前网关重定向的最新 queryString
 */
async function detectQueryString(serverHost) {
  try {
    // 尝试访问任意 HTTP 触发 302 重定向
    const res = await request({
      host: '1.1.1.1',
      port: 80,
      path: '/',
      method: 'GET'
    });

    if (res.statusCode === 302 && res.headers.location) {
      const loc = res.headers.location;
      const qIndex = loc.indexOf('?');
      if (qIndex !== -1) {
        return loc.substring(qIndex + 1);
      }
    }
  } catch (err) {
    // 探测失败是正常的，可能网关直接允许或拦截方式不同
  }
  return null;
}

/**
 * 获取当前公钥信息
 */
async function fetchPageInfo(serverHost, queryString) {
  const doubleEncodedQuery = encodeURIComponent(encodeURIComponent(queryString));
  const postData = `queryString=${doubleEncodedQuery}`;

  const res = await request({
    host: serverHost,
    port: 80,
    path: '/eportal/InterFace.do?method=pageInfo',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);

  if (res.statusCode === 200 && res.body) {
    return JSON.parse(res.body);
  }
  throw new Error(`获取公钥信息失败，状态码: ${res.statusCode}`);
}

/**
 * 执行认证登录
 */
async function doLogin(config, queryString) {
  const serverHost = config.serverHost || '172.10.110.252';

  // 1. 获取公钥与加密配置
  log('正在从认证服务器获取加密公钥...');
  const pageInfo = await fetchPageInfo(serverHost, queryString);
  const exponent = pageInfo.publicKeyExponent || '10001';
  const modulus = pageInfo.publicKeyModulus;

  if (!modulus) {
    throw new Error('未获取到有效的 RSA 公钥模数 (publicKeyModulus)');
  }

  // 2. 从 queryString 中提取 mac
  let mac = '111111111';
  const match = queryString.match(/(?:^|&)mac=([^&]*)/);
  if (match && match[1]) {
    mac = match[1];
  }

  // 3. 执行密码加密
  log(`使用 MAC[${mac}] 与公钥加密密码...`);
  const encryptedPassword = encryptPassword(config.password, mac, exponent, modulus);

  // 4. 组装登录参数 (按前端 login_bch.js 逻辑进行两次 URL 编码)
  const encUserId = encodeURIComponent(encodeURIComponent(config.userId));
  const encPassword = encodeURIComponent(encodeURIComponent(encryptedPassword));
  const encService = '';
  const encQueryString = encodeURIComponent(encodeURIComponent(queryString));
  const encPasswordEncrypt = encodeURIComponent(encodeURIComponent('true'));

  const postBody = `userId=${encUserId}&password=${encPassword}&service=${encService}&queryString=${encQueryString}&operatorPwd=&operatorUserId=&validcode=&passwordEncrypt=${encPasswordEncrypt}`;

  log('向认证网关发送登录请求...');
  const loginRes = await request({
    host: serverHost,
    port: 80,
    path: '/eportal/InterFace.do?method=login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Content-Length': Buffer.byteLength(postBody)
    }
  }, postBody);

  if (loginRes.statusCode === 200 && loginRes.body) {
    let resultJson;
    try {
      resultJson = JSON.parse(loginRes.body);
    } catch (e) {
      throw new Error(`登录返回格式非JSON: ${loginRes.body}`);
    }

    if (resultJson.result === 'success') {
      log(`登录成功！${resultJson.message || ''}`);
      return true;
    } else {
      log(`登录失败: ${resultJson.message || '未知错误'}`);
      return false;
    }
  } else {
    throw new Error(`登录请求响应异常，状态码: ${loginRes.statusCode}`);
  }
}

async function main() {
  log('========== 校园网自动登录任务启动 ==========');
  const config = loadConfig();
  const campusIp = getCampusLocalIp();
  log(`检测到物理网卡 IP: ${campusIp || '未检测到，将尝试默认路由'}`);

  const forceLogin = process.argv.includes('--force');

  // 步骤 1: 检查是否已在线
  if (!forceLogin) {
    const onlineStatus = await checkIsOnline(config.serverHost);
    if (onlineStatus.isOnline) {
      log('当前设备已处于在线登录状态，无需重复登录。');
      log('============================================');
      return;
    }
    log('当前未登录，准备发起认证连接...');
  } else {
    log('已指定 --force 参数，跳过在线检查，强制发起认证登录...');
  }

  // 步骤 2: 获取 queryString
  let queryString = await detectQueryString(config.serverHost);
  if (!queryString) {
    log('未捕获到实时重定向参数，使用配置文件中的预设参数。');
    queryString = config.defaultQueryString;
  } else {
    log('成功捕获到实时重定向参数。');
  }

  // 步骤 3: 循环重试登录
  const maxRetries = config.retryCount || 3;
  const retryDelay = config.retryDelayMs || 5000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log(`开始第 ${attempt}/${maxRetries} 次登录尝试...`);
    try {
      const success = await doLogin(config, queryString);
      if (success) {
        log('========== 校园网自动登录完成 ==========');
        process.exit(0);
      }
    } catch (err) {
      log(`第 ${attempt} 次尝试发生异常: ${err.message}`);
    }

    if (attempt < maxRetries) {
      log(`等待 ${retryDelay / 1000} 秒后进行重试...`);
      await new Promise((r) => setTimeout(r, retryDelay));
    }
  }

  log('已达到最大重试次数，未能成功登录。');
  log('============================================');
  process.exit(1);
}

main().catch((err) => {
  log(`主流程异常终止: ${err.stack || err.message}`);
  process.exit(1);
});

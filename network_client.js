const http = require('http');
const os = require('os');

/**
 * 自动寻找本机校园网物理网卡 IP (172.10.x.x)
 */
function getCampusLocalIp() {
  const interfaces = os.networkInterfaces();
  let candidateIp = null;

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // 排除 IPv6 和回环地址
      if (net.family === 'IPv4' && !net.internal) {
        // 优先匹配校园网 172.10.x.x 网段
        if (net.address.startsWith('172.10.')) {
          return net.address;
        }
        // 备选非代理网卡（排除 198.18.x.x 虚拟网卡和 169.254.x.x 自动配置地址）
        if (!net.address.startsWith('198.18.') && !net.address.startsWith('169.254.') && !net.address.startsWith('127.')) {
          candidateIp = net.address;
        }
      }
    }
  }

  return candidateIp;
}

/**
 * 发起 HTTP 请求，自动绑定物理网卡以绕过代理/TUN虚拟网卡干扰
 */
function request(options, postData = null) {
  return new Promise((resolve, reject) => {
    const localIp = getCampusLocalIp();
    const defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Connection': 'keep-alive'
    };

    const reqOptions = {
      timeout: 5000,
      ...options,
      headers: {
        ...defaultHeaders,
        ...(options.headers || {})
      }
    };

    if (localIp) {
      reqOptions.localAddress = localIp;
    }

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`请求超时 (${reqOptions.host || reqOptions.hostname})`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

module.exports = {
  getCampusLocalIp,
  request
};

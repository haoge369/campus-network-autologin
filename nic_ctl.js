// 校园网物理网卡自动启用模块
//
// 场景：用户可能手动禁用了物理网卡（例如 Realtek PCIe 2.5GbE），两种方式都支持：
//   1) 「网络连接」右键 -> 禁用          -> Enable-NetAdapter
//   2) 「设备管理器」右键 -> 禁用设备     -> Enable-PnpDevice（Code 22，网卡仍是 Disabled 状态）
//   3) 设备管理器里卸载了网卡            -> PnP 重新扫描自动装回驱动
// 自动登录前先检测该网卡是否被禁用，若被禁用则自动启用，并等待校园网 IP
// (172.10.x.x) 就绪后再继续认证流程；若网卡已启用但 DHCP 一直不下发 IP，
// 会调用 ipconfig /renew 刷新租约。
//
// 依赖：enable_campus_nic.ps1（输出 KEY=VALUE 纯 ASCII，避免受系统语言影响），
// 且调用方需要管理员权限（计划任务已以 Highest 运行，手动运行请用 run_now.vbs
// 或「以管理员身份运行」run.bat）。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getCampusIp } = require('./network_client');

const DEFAULT_ADAPTER_MATCH = 'Realtek PCIe 2.5GbE';
const DEFAULT_WAIT_MS = 30000;
const PS_SCRIPT = path.join(__dirname, 'enable_campus_nic.ps1');
const PS_TIMEOUT_MS = 60000;

function getPowerShellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell.exe';
}

function parseKeyValues(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);

  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;

    const key = m[1];
    const value = m[2].trim();

    // *_B64 字段承载中文（网卡名、错误信息），base64 传输避免 OEM 代码页乱码
    if (key.endsWith('_B64')) {
      const plainKey = key.slice(0, -4);
      try {
        out[plainKey] = Buffer.from(value, 'base64').toString('utf8');
      } catch (e) {
        out[plainKey] = '';
      }
    } else {
      out[key] = value;
    }
  }

  return out;
}

/**
 * 执行 enable_campus_nic.ps1，返回解析后的 KEY=VALUE 对象
 */
function runEnableScript(matchHint, timeoutMs = PS_TIMEOUT_MS, extraArgs = []) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    if (!fs.existsSync(PS_SCRIPT)) {
      return finish({ RESULT: 'error', MESSAGE: `找不到脚本: ${PS_SCRIPT}` });
    }

    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', PS_SCRIPT,
      '-MatchHint', matchHint || DEFAULT_ADAPTER_MATCH
    ].concat(extraArgs);

    let child;
    try {
      // windowsHide 很关键：开机/定时任务由 wscript 静默启动，子进程不能弹出黑框
      child = spawn(getPowerShellPath(), args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      return finish({ RESULT: 'error', MESSAGE: err.message });
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* ignore */ }
      finish({ RESULT: 'error', MESSAGE: `PowerShell 执行超时 (${timeoutMs}ms)` });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ RESULT: 'error', MESSAGE: err.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish(parseKeyValues(output));
    });
  });
}

/**
 * 确保物理网卡处于启用状态
 * @returns {Promise<{action:'enabled'|'already'|'notfound'|'error', adapter?:string, method?:string, status?:string, statusAfter?:string, message?:string, raw?:object}>}
 */
async function ensureCampusAdapter(matchHint = DEFAULT_ADAPTER_MATCH) {
  const kv = await runEnableScript(matchHint);

  switch (String(kv.RESULT || '').toLowerCase()) {
    case 'enabled':
      return {
        action: 'enabled',
        adapter: kv.ADAPTER || '',
        method: kv.METHOD || 'unknown',
        status: kv.STATUS || '',
        statusAfter: kv.STATUS_AFTER || '',
        raw: kv
      };
    case 'already':
      return {
        action: 'already',
        adapter: kv.ADAPTER || '',
        method: kv.METHOD || 'none',
        status: kv.STATUS || '',
        raw: kv
      };
    case 'notfound':
      return { action: 'notfound', raw: kv };
    case 'error':
      return { action: 'error', message: kv.MESSAGE || '未知错误', raw: kv };
    default:
      return {
        action: 'error',
        message: '无法解析启用脚本输出: ' + JSON.stringify(kv),
        raw: kv
      };
  }
}

/**
 * 生成网卡/设备/IP 诊断报告（node nic_ctl.js --diag）
 * @returns {Promise<string>} 多行文本报告
 */
async function runDiag(matchHint = DEFAULT_ADAPTER_MATCH) {
  const kv = await runEnableScript(matchHint, PS_TIMEOUT_MS, ['-Diag']);
  if (String(kv.RESULT || '').toLowerCase() === 'diag' && kv.DIAG) {
    return kv.DIAG;
  }
  return '诊断脚本执行失败: ' + JSON.stringify(kv);
}

/**
 * 只查询物理网卡当前状态，不做任何修改
 * （自动任务再用它判断“是否允许自动启用”，避免用户手动禁用后被反复拉起）
 * @returns {Promise<{state:'enabled'|'disabled'|'notfound'|'error', adapter?:string, status?:string, pnpProblem?:string, message?:string}>}
 */
async function getAdapterState(matchHint = DEFAULT_ADAPTER_MATCH) {
  const kv = await runEnableScript(matchHint, PS_TIMEOUT_MS, ['-CheckOnly']);
  const result = String(kv.RESULT || '').toLowerCase();
  if (result === 'enabled' || result === 'disabled' || result === 'notfound') {
    return {
      state: result,
      adapter: kv.ADAPTER || '',
      status: kv.STATUS || '',
      pnpProblem: kv.PNP_PROBLEM || ''
    };
  }
  return {
    state: 'error',
    message: kv.MESSAGE || ('无法解析网卡状态: ' + JSON.stringify(kv))
  };
}

/**
 * 刷新指定网卡的 DHCP 租约（ipconfig /renew "<网卡名>"）
 * @param {string} adapterName 网卡名称，例如 "以太网"
 * @param {number} timeoutMs 超时
 * @returns {Promise<boolean>} ipconfig 是否正常退出
 */
function renewAdapterDhcp(adapterName, timeoutMs = 20000) {
  return new Promise((resolve) => {
    if (!adapterName) return resolve(false);

    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const ipconfig = path.join(root, 'System32', 'ipconfig.exe');
    let child;
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    try {
      child = spawn(fs.existsSync(ipconfig) ? ipconfig : 'ipconfig.exe', ['/renew', adapterName], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      return finish(false);
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* ignore */ }
      finish(false);
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish(true);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询等待校园网 IP (172.10.x.x) 就绪
 * @param {number} timeoutMs 最长等待时间
 * @param {number} intervalMs 轮询间隔
 * @param {(waitedMs:number)=>void} [onTick] 每秒回调，用于输出进度日志
 * @returns {Promise<string|null>} 就绪的 IP，超时返回 null
 */
async function waitForCampusIp(timeoutMs = DEFAULT_WAIT_MS, intervalMs = 1000, onTick) {
  const deadline = Date.now() + timeoutMs;
  let waited = 0;

  for (;;) {
    const ip = getCampusIp();
    if (ip) return ip;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
    waited += intervalMs;
    if (typeof onTick === 'function') onTick(waited);
  }
}

module.exports = {
  DEFAULT_ADAPTER_MATCH,
  DEFAULT_WAIT_MS,
  ensureCampusAdapter,
  getAdapterState,
  runDiag,
  renewAdapterDhcp,
  waitForCampusIp,
  parseKeyValues
};

// 手动自测：
//   node nic_ctl.js                 检查并启用网卡，然后等待校园网 IP
//   node nic_ctl.js <匹配关键字>     自定义网卡匹配关键字
//   node nic_ctl.js --diag          打印网卡/设备/IP 诊断报告
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);

    if (args.includes('--diag')) {
      const hint = args.find((a) => !a.startsWith('--')) || DEFAULT_ADAPTER_MATCH;
      console.log(await runDiag(hint));
      process.exit(0);
    }

    const hint = args.find((a) => !a.startsWith('--')) || DEFAULT_ADAPTER_MATCH;
    console.log(`检查适配器: ${hint}`);
    const result = await ensureCampusAdapter(hint);
    console.log(JSON.stringify(result, null, 2));

    if (result.action === 'enabled' || result.action === 'already') {
      console.log('等待校园网 IP ...');
      const ip = await waitForCampusIp(DEFAULT_WAIT_MS, 1000, (ms) => console.log(`  +${ms / 1000}s`));
      console.log(ip ? `校园网 IP 已就绪: ${ip}` : '等待超时，仍未获取到 172.10.x.x 地址');
      process.exit(ip ? 0 : 1);
    }
    process.exit(result.action === 'error' ? 1 : 0);
  })();
}

# Campus Network Auto Login（锐捷校园网自动登录套件）

Windows 上的锐捷（Ruijie）eportal 校园网自动登录工具：零第三方依赖，只用 Node.js 标准库。
模拟网页认证流程（抓实时参数 → RSA 加密密码 → 提交认证），并附带网卡自愈、每次开机只自动登录一次等能力。

> **v2.0.0 说明**：登录核心已按 v1 的稳定流程重构——在线判定只认门户会话、参数只从配置的探测地址抓、
> 连续重试、成功后做一次轻量校验。v1.1.4–v1.1.6 引入的「等待网关放行 / 注销旧会话 / 跟随跳转链」
> 等猜测性逻辑已全部移除，避免正常登录被这些额外步骤拖慢或误判失败。

## 功能特性

- **模拟网页认证**：抓取门户重定向里的实时 `queryString`，用门户下发的 RSA 公钥加密密码后提交登录。
- **在线检查**：先查 `getOnlineUserInfo`，已在线直接跳过，不重复登录。
- **网卡自愈**：校园网网卡被禁用时自动启用（支持「设备管理器禁用」和「网络连接禁用」两种），再等 DHCP 分配 IP。
- **每次开机只自动登录一次**：登录 Windows 后自动执行一次；之后即使计划任务再触发也不会重复登录。
- **尊重手动禁用**：你手动禁用的网卡不会被自动任务反复拉起（`autoEnable: "once"`）。
- **外网诊断（仅 `--status`）**：`--status` 附带 `internet` 字段，告诉你「门户在线是否真能上网」，不阻断登录。
- **快速启动友好**：用系统日志里的 Kernel-Boot 事件识别「这一次开机」，开启 Windows 快速启动也能正确判断。
- **静默运行 / 弹窗提示**：计划任务用 `run_silent.vbs` 静默执行；手动双击 `run_now.vbs` 有成功/失败弹窗。
- **零依赖**：不需要 `npm install`，不安装任何第三方包。

## 目录结构

```
campus-network-autologin/
├── campus_login.js          # 主程序：配置、在线检查、抓参数、加密、登录、重试、网卡自愈
├── network_client.js        # HTTP 客户端（含源 IP 绑定与失败重试）、网卡选择
├── nic_ctl.js               # 调用 PowerShell 检查/启用网卡、刷新 DHCP
├── enable_campus_nic.ps1    # 网卡启用脚本（PnP 禁用 / 网络连接禁用都能处理）
├── rsa_util.js              # 加载门户 RSA 库并加密密码
├── security.js              # 锐捷门户用的 RSA 实现（来自官方页面）
├── config.json              # 你的配置（含账号，已被 .gitignore 排除）
├── config.example.json      # 配置模板
├── run_now.vbs              # 手动运行（wscript 启动，不经过 cmd.exe，带弹窗）
├── run_silent.vbs           # 计划任务用：静默运行（默认 --auto --quiet，--daily 时传 --daily）
├── run.bat                  # 兼容用（依赖 cmd.exe，双击会看到控制台）
├── setup_tasks.ps1          # 注册/更新计划任务
├── uninstall_tasks.ps1      # 删除计划任务
├── protect_password.ps1     # 把明文密码迁移成 DPAPI 加密的 passwordEnc
├── test/                    # node:test 测试（含本地假门户集成测试）
├── state.json               # 运行状态（开机标识、自动执行记录，已被忽略）
├── campus_login.log         # 运行日志（已被忽略）
└── README.md / CHANGELOG.md / LICENSE
```

## 快速开始

1. 安装 Node.js 18 或更高版本（`node -v` 能输出版本即可）。
2. 复制 `config.example.json` 为 `config.json`，填入学号、密码；`defaultQueryString` 可留空。
3. 手动运行一次看看：双击 `run_now.vbs`（或 `node campus_login.js`）。
4. 用管理员 PowerShell 注册开机自动登录：
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\setup_tasks.ps1
   ```
5. （可选）把明文密码迁移成 DPAPI 加密：
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\protect_password.ps1
   ```

## 日常使用

| 想做什么 | 怎么做 |
| --- | --- |
| 立即登录一次 | 双击 `run_now.vbs`（推荐）或 `node campus_login.js` |
| 强制重新登录 | `node campus_login.js --force` |
| 查看当前状态 | `node campus_login.js --status` |
| 诊断网卡 | `node nic_ctl.js --diag` |
| 查看日志 | 打开 `campus_login.log` |
| 卸载计划任务 | 管理员运行 `.\uninstall_tasks.ps1` |

`--status` 输出一行 JSON，例如（IP / MAC 为虚构示例）：

```json
{"version":"2.0.0","time":"2026-11-02 10:00:00","serverHost":"172.10.110.252","adapterMatch":"Realtek PCIe 2.5GbE","autoEnable":"once","nic":{"name":"以太网","state":"enabled","status":"Up","address":"172.10.1.100","mac":"001122334455"},"ip":"172.10.1.100","online":true,"unreachable":false,"internet":true}
```

## 配置项（config.json）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `userId` | 必填 | 学号 / 账号 |
| `password` | 必填 | 明文密码（与 `passwordEnc` 二选一） |
| `passwordEnc` | 无 | DPAPI 加密后的密码（推荐，用 `protect_password.ps1` 生成） |
| `serverHost` | `172.10.110.252` | 门户地址 |
| `portalPort` | `80` | 门户端口 |
| `defaultQueryString` | 空 | 抓不到实时参数时的兜底参数 |
| `probeUrls` | 1.1.1.1 / miui generate_204 / msftconnecttest | 抓取实时参数用的「会被门户劫持」的探测地址，按顺序尝试 |
| `adapterMatch` | `Realtek PCIe 2.5GbE` | 校园网网卡匹配关键字（网卡描述或名称） |
| `manageAdapter` | `true` | 是否允许脚本管理网卡（`false` 完全不碰网卡） |
| `autoEnable` | `once` | 网卡自动启用策略：`once` 每次开机最多一次 / `always` 每次都启用 / `never` 从不启用 |
| `oncePerBoot` | `true` | 每次开机（自动触发）只登录一次 |
| `nicEnableWaitMs` | `60000` | 启用网卡后等待 IP 的最长毫秒数 |
| `retryCount` | `3` | 登录最大重试次数 |
| `retryDelayMs` | `5000` | 两次重试之间的等待毫秒数 |
| `requestTimeoutMs` | `5000` | 单次 HTTP 请求超时 |
| `verifyAfterLoginMs` | `1500` | 登录接口成功后再查一次门户在线状态的等待时间 |
| `logMaxBytes` | `1048576` | 日志超过此大小轮转为 `campus_login.log.1` |
| `lockStaleMs` | `300000` | 锁文件被视为过期的毫秒数 |
| `internetProbes` | connecttest.txt / generate_204 | 仅 `--status` 诊断用 |

`config.json` 已被 `.gitignore` 排除，不会提交到仓库。

## 密码加密（推荐）

明文密码会被 `protect_password.ps1` 迁移成 Windows DPAPI 加密的 `passwordEnc`：

```powershell
powershell -ExecutionPolicy Bypass -File .\protect_password.ps1
```

迁移后 `config.json` 里只有 `passwordEnc`，脚本通过 DPAPI（CurrentUser）解密，别人拿到文件也解不开。

## 网卡自动启用（自愈）说明

登录前脚本会做三件事：

1. **检查**网卡是否被禁用（设备管理器禁用 = PnP `CM_PROB_DISABLED`；网络连接禁用 = `AdminStatus=Down`）；
2. 若禁用且允许自动启用（见 `autoEnable`），调用 `enable_campus_nic.ps1` 启用，并等网卡进入可用状态；
3. 轮询 `172.10.x.x` 地址，最多 `nicEnableWaitMs`，期间按需 `ipconfig /renew`，拿到 IP 后再登录。

### 每次开机只自动登录一次

`CampusLogin_AutoStartup` 只在登录 Windows 后触发一次（延迟 15 秒）。自动运行时：

1. 检查 `state.json` 里的 `bootId`（开机标识）是否就是本次开机；
2. 不是 → 正常执行（网卡自愈 + 登录），并把本次开机记入 `state.json`；
3. 是 → 直接跳过（日志「本次开机已经自动执行过登录，跳过本次触发」）。

`CampusLogin_Daily0610`（每天 06:10）带 `--daily` 参数，不受「每次开机一次」限制，用于日常确认在线状态。

### 手动禁用的网卡不会被反复启用

`autoEnable` 默认 `once`：本次开机已经自动处理过网卡后，你若在设备管理器里禁用网卡，自动任务**不会**
再把它打开，只在日志里说明并跳过；想立刻上网请手动双击 `run_now.vbs`（手动运行始终允许启用网卡）。

## 计划任务

| 任务 | 触发 | 说明 |
| --- | --- | --- |
| `CampusLogin_AutoStartup` | 登录 Windows 后 15 秒 | 每次开机只执行一次，静默运行 |
| `CampusLogin_Daily0610` | 每天 06:10 | 带 `--daily`，确认在线状态 |

注册 / 更新：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup_tasks.ps1
```

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 已在线 / 登录成功 / 本次开机已执行过（跳过） |
| `1` | 登录失败（账号密码、参数或重试耗尽） |
| `2` | 网络未就绪（拿不到 172.10.x.x，或网卡被你手动禁用而本次不自动启用） |
| `3` | 配置错误（缺少账号、参数或配置文件无法读取） |

`run_now.vbs` 会根据退出码弹不同提示；计划任务静默运行，结果看日志与任务历史。

## 常见问题

**Q：双击 `run_now.vbs` 弹出「网络还没有真正就绪（返回码 2）」？**
A：脚本没拿到 `172.10.x.x` 地址，常见原因是网线没插好、DHCP 没响应，或网卡被你在设备管理器里禁用且本次不允许自动启用。
查看 `campus_login.log` 最后几行，或运行 `node nic_ctl.js --diag` 看网卡状态。

**Q：日志写「当前设备已处于在线登录状态」但网页打不开？**
A：这是门户会话仍有效。先运行 `node campus_login.js --status` 看 `internet` 字段；为 `false` 说明门户在线但数据面还没放行，
通常等几十秒或打开一次浏览器门户页就会恢复。

**Q：开机没有自动登录？**
A：① 确认计划任务存在且已启用：`schtasks /query /tn CampusLogin_AutoStartup`；
② 看 `campus_login.log` 有没有「任务启动 (v2.0.0)」记录；
③ 若提示「本次开机已经自动执行过」，说明本次开机已跑过（`state.json` 记录）；
④ 若你开机后立刻在设备管理器禁用网卡，按设计不会自动启用，请手动双击 `run_now.vbs`。

**Q：怎么完全关掉自动登录？**
A：管理员运行 `.\uninstall_tasks.ps1`。

## 开发与测试

```powershell
node --check campus_login.js
node --test "test/*.test.js"     # 51 个用例
```

> 本机 PowerShell 若禁止运行 `npm.ps1`，用 `node --test` 直接跑，或 `& "C:\Program Files\nodejs\npm.cmd" test`。

测试用本地假门户验证登录链路（不连真实校园网）；网卡自愈、开机只跑一次等纯逻辑各有单测。

## 安全提示

- `config.json`、`campus_login.log`、`state.json` 均已被 `.gitignore` 排除，请勿手动提交。
- 推荐用 `protect_password.ps1` 把密码转成 DPAPI 加密，避免明文落盘。
- 日志含本机 IP / MAC，分享前请先脱敏。

## 更新记录

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

MIT

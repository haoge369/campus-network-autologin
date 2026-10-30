# 更新记录

## v1.1.2 (2026-10-30)

### 修复
- **门户已在线时被误判为「登录失败」**：门户的 `getOnlineUserInfo` 有时返回
  `{"userIndex":"..."}`（没有 `result` 字段），或者门户根路径直接 302 跳
  `redirectortosuccess`；旧逻辑只认 `result === 'success'`，于是判定「未登录」，
  接着抓不到实时参数、回落到过期的 `defaultQueryString`，`pageInfo` 返回空响应，
  最终以退出码 1 报错（日志里「门户对 pageInfo 返回空响应」）。
  现在在线判定放宽为三条信号任一命中：带 `userIndex` 的 JSON / `redirectortosuccess`
  302 跳 `success.jsp` / 门户根路径 302 跳 `redirectortosuccess`；
  并且在 `pageInfo` 空响应时复核在线状态，确认在线就按成功结束（退出码 0）。
- 判定为离线时，日志会打印三条探测的 HTTP 状态码与响应字节数，方便下次直接定位。
- **计划任务可能静默空转**：`run_silent.vbs` 之前以 UTF-8（无 BOM）保存，含中文注释时会被
  WSH 按 ANSI 解析，部分环境下 `ws.Run` 不报错却根本没启动 node——计划任务显示
  `LastTaskResult=0`，但日志里没有任何新记录。现改为 UTF-16LE（带 BOM）保存，与
  `run_now.vbs` 一致，并已用 `Start-ScheduledTask` 实测确认日志正常写入。

### 新增
- `test/online_probe.test.js`：5 个在线判定用例（含非 JSON、全空、根路径跳转等）。
- 假门户新增「已在线 + pageInfo 空响应」集成用例（复现本次故障场景，断言退出码 0）。

## v1.1.1 (2026-10-30)

### 修复
- **手动禁用的网卡被计划任务反复启用**：`CampusLogin_AutoStartup` 每 5 分钟重试一次，每次都会
  调用网卡自愈，把用户刚手动禁用的网卡又启用。现在新增 `autoEnable` 策略（默认 `once`）：
  每次开机最多自动启用一次，之后尊重用户的手动禁用选择；不再自动启用时直接以退出码 `2`
  （网络未就绪）结束，不做无意义的登录重试。

### 新增
- 配置项 `autoEnable`：`once`（默认）/ `always`（旧行为）/ `never`。
- 状态文件 `state.json`：记录 `bootId`、`bootHandledAt`、`enableCount`、`lastEnableAt`，
  重启后自动失效。
- 命令行参数 `--auto`（计划任务模式）；`run_silent.vbs` 改为传 `--auto --quiet`。
- `enable_campus_nic.ps1 -CheckOnly` 与 `nic_ctl.getAdapterState()`：登录前只查询网卡状态，
  不改动网卡。
- `--status` 输出新增 `autoEnable` 与 `nic.state` / `nic.status` 字段。
- 单元测试新增 `test/enable_guard.test.js`（13 个用例），测试总数 28 → 40。

## v1.1.0 (2026-10-29)

### 修复
- **请求绑定错误网卡**：只在拿到 172.10.x.x 时才绑定源地址，否则交给系统选路；绑定后报
  "无路由/地址不可用" 会自动去绑定重试一次。修复历史日志里的 `connect ENETUNREACH`。
- **queryString 抓取**：先请求门户网关（必然 302），1.1.1.1 降级为备选探测地址，并支持
  `probeUrls` 配置；抓取失败时日志会输出完整 Location，便于排查。
- **假成功**：登录接口返回 `success` 后追加二次校验，未真正在线则重试，不再误报成功。
- **MAC 兜底**：queryString 无 `mac` 时改用网卡真实 MAC；仍取不到直接失败并提示
  queryString 可能过期，不再静默使用 `111111111`。
- **网络异常误判**：在线检测遇到网络不可达时返回 `unreachable`，不再当成"离线"直接去登录。

### 新增
- 网卡禁用自愈同时支持「设备管理器禁用」（`Enable-PnpDevice`，Code 22）与「网络连接禁用」
  （`Enable-NetAdapter`），含 PnP 驱动重装、等待 IP、`ipconfig /renew` 刷租约。
- `campus_login.js --status`：一行 JSON 输出在线状态/IP/网卡/MAC，便于外部脚本与排查。
- `campus_login.js --force` / `--quiet` / `--help`。
- 单实例锁 `campus_login.lock`（并发双击只跑一个，陈旧锁自动清理）。
- 错误分类 + 指数退避重试；退出码语义化：`0` 成功/已在线、`1` 登录失败、
  `2` 网络未就绪、`3` 配置错误。
- 日志轮转（超过 1 MB 转为 `campus_login.log.1`），时间改为固定 `YYYY-MM-DD HH:mm:ss`。
- `protect_password.ps1`：用 Windows DPAPI 加密 config.json 里的密码并收紧 ACL。
- `package.json` + `node:test` 单元测试 + GitHub Actions（Windows，Node 18/20/22）。
- `run_now.vbs`：wscript → node 启动器，完全绕过 cmd.exe，规避 `cmd.exe 0xc0000142` 弹窗。
- `node nic_ctl.js --diag`：一次性打印 NetAdapter / PnP / IPv4 三张表，便于排查网卡与 IP 问题。
- 集成测试 `test/login_flow.test.js`：本机随机端口起假门户，跑通「实时抓 queryString → 登录 →
  二次校验」及认证被拒、二次校验失败、无参数回落等路径；单元测试总数 28 个。
- 可测试性开关：`portalPort`（默认 80）、`manageAdapter`（默认 true）、`CAMPUS_LOGIN_LOG`
  日志路径覆盖，便于在本机对着假门户验证。
- 计划任务增加失败重启（`RestartCount` 3 次 / 5 分钟）与「登录后每 5 分钟重试、持续 2 小时」
  的重复触发（`MultipleInstances IgnoreNew` 保证不并发）。

### 变更
- `run.bat` 去掉 UAC 自提权链（它会把 cmd.exe 卷进启动链），改为推荐 `run_now.vbs`。
- `run_silent.vbs` 支持探测 Node 安装路径，不再硬编码单个路径。
- 真实 `config.json` 已迁移为 DPAPI `passwordEnc`（明文 `password` 不再落盘），
  并已把文件 ACL 收紧到当前用户。
- 配置新增：`probeUrls`、`service`、`operatorUserId`、`retryDelayMs`、`authFailureDelayMs`、
  `requestTimeoutMs`、`verifyAfterLoginMs`、`logMaxBytes`、`lockStaleMs`；
  `nicEnableWaitMs` 默认 30 s → 60 s。
- 项目零依赖保持不变。

## v1.0.0 (2026-10-26)

- 初版：锐捷 eportal 认证、RSA 密码加密、开机自启 + 每日 06:10 计划任务、
  静默运行、日志记录。

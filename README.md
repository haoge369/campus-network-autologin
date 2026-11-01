# Campus Network Auto Login（锐捷校园网自动登录与定时连接套件）

Windows 上的免干预校园网登录工具：**每次开机登录 Windows 后自动登录一次**，每天 06:10 再确认一次。
如果物理网卡被手动禁用（**设备管理器禁用**或**网络连接禁用**），会先自动启用网卡、
等 DHCP 下发 172.10.x.x 地址后再认证；网卡被卸载时还会自动重扫驱动。
登录成功不只信门户的「在线」回执，还会真实探测外网，避免「显示连接成功、其实上不了网」。
纯 Node.js 实现，**零第三方依赖**。

## 功能特性

- 兼容锐捷 eportal 认证流程（RSA 加密密码、queryString 实时抓取）
- 网卡禁用自愈：设备管理器禁用（Code 22，`Enable-PnpDevice`）、网络连接禁用（`Enable-NetAdapter`）、
  卸载（`pnputil /scan-devices`）都能恢复；网卡启用后等 IP，必要时自动 `ipconfig /renew`
- 不依赖 cmd.exe 的启动器 `run_now.vbs`：彻底规避 `cmd.exe - Application Error (0xc0000142)` 弹窗
- **每次开机只自动登录一次**：计划任务只在登录后 15 秒触发一次（无 5 分钟重复触发），
  自动运行会把「本次开机已自动执行过」写入 `state.json`，之后即使再触发也直接跳过（`--auto` 模式）
- **尊重手动禁用**：自动运行每次开机最多自动启用一次网卡；之后你手动禁用网卡不会被它重新打开
  （手动双击 `run_now.vbs` 仍会立刻启用并登录，下次开机恢复自动启用）
- **外网可达性校验**：门户说「在线」时再探测真实外网（`connecttest.txt` / `generate_204`），
  门户假在线、被劫持或外网不通时不会误报成功；刚开机网关还没放行时会自动等待复查
  （v1.1.4 起，默认最多约 90 秒，必要时尝试注销旧会话重新认证），仍不可达才返回退出码 2
- 计划任务以最高权限静默运行（登录后 15 秒一次；每天 06:10 一次）
- 单实例锁：多次双击也只会真正跑一个登录进程
- 登录后二次校验，避免「接口说成功、实际没在线」的假成功
- 错误分类 + 指数退避重试，退出码区分「登录失败 / 网络未就绪 / 配置错误」
- 固定格式日志（`YYYY-MM-DD HH:mm:ss`），超过 1 MB 自动轮转为 `campus_login.log.1`
- 单元测试 + GitHub Actions（Windows，Node 18/20/22）

## 目录结构

```
campus-network-autologin/
├── campus_login.js          # 主流程：在线检查 → queryString → RSA 登录 → 二次校验
├── network_client.js        # HTTP 客户端（默认只绑校园网 IP，绑定失败自动去绑定重试）
├── nic_ctl.js               # 网卡自愈：调用 enable_campus_nic.ps1、等 IP、刷 DHCP 租约
├── enable_campus_nic.ps1    # PowerShell 侧：Enable-PnpDevice / Enable-NetAdapter / 驱动重扫
├── rsa_util.js              # 加载官方 security.js 做 RSA 加密
├── security.js              # 锐捷官方 RSA 库（第三方，勿修改）
├── run_now.vbs              # 推荐的手动启动器（wscript → node，不经过 cmd.exe）
├── run_silent.vbs           # 计划任务用的静默启动器（自动探测 Node 安装路径）
├── run.bat                  # 兼容入口（需要 cmd.exe；遇到 0xc0000142 时改用 run_now.vbs）
├── setup_tasks.ps1          # 注册/更新计划任务（管理员运行）
├── uninstall_tasks.ps1      # 删除计划任务
├── protect_password.ps1     # 用 DPAPI 加密 config.json 密码并收紧 ACL
├── config.example.json      # 配置模板（复制为 config.json 后修改）
├── state.json               # 运行状态（本次开机是否已自动登录/已自动启用过网卡，自动生成）
├── package.json             # npm scripts（check / test / status / diag / login）
├── test/                    # node:test 单元测试
└── .github/workflows/ci.yml # GitHub Actions
```

## 快速开始

1. 安装 **Node.js 18+**（推荐 LTS，默认路径 `C:\Program Files\nodejs`）。
2. 复制配置模板并填写账号：

   ```powershell
   Copy-Item .\config.example.json .\config.json
   notepad .\config.json
   ```

3. 先验证能登录（会输出日志）：

   ```powershell
   node .\campus_login.js --status   # 一行 JSON，看 IP / 在线状态
   node .\campus_login.js            # 已在线就直接退出；未在线则登录
   node .\campus_login.js --force    # 不管在不在线，强制登录一次
   ```

4. 注册计划任务（**以管理员身份**运行 PowerShell）：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\setup_tasks.ps1
   ```

5. 平时手动连网：双击 `run_now.vbs` 或桌面快捷方式即可（管理员权限才能启用被禁用的网卡）。

## 日常使用

| 想做 | 怎么做 |
| --- | --- |
| 连一下网 | 双击 `run_now.vbs`（或桌面「校园网自动登录」快捷方式） |
| 静默跑一次（无弹窗） | `wscript .\run_now.vbs /quiet` |
| 保持网卡禁用不被自动拉起 | 直接禁用即可；自动任务每次开机只跑一次、最多自动启用一次网卡（见「网卡自动启用」） |
| 查当前状态 | `node .\campus_login.js --status` 或 `npm run status` |
| 强制重新登录 | `node .\campus_login.js --force` |
| 网卡诊断 | `node .\nic_ctl.js --diag` 或 `npm run diag` |
| 看日志 | `Get-Content .\campus_login.log -Tail 30` |
| 更新计划任务 | 管理员 PowerShell 再跑一次 `setup_tasks.ps1` |
| 卸载计划任务 | 管理员 PowerShell 跑 `uninstall_tasks.ps1` |

`--status` 输出示例（一行 JSON，便于外部脚本消费）：

```json
{"version":"1.1.4","time":"2026-10-31 22:32:33","serverHost":"172.10.110.252","adapterMatch":"Realtek PCIe 2.5GbE","autoEnable":"once","nic":{"name":"以太网","state":"enabled","status":"Up","address":"172.10.1.100","mac":"001122334455"},"ip":"172.10.1.100","online":true,"unreachable":false,"internet":true}
```

（示例中的 IP / MAC 为虚构值，避免泄露真实网络标识。）

## 配置项（config.json）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `userId` | 必填 | 学号 / 上网账号 |
| `password` | 必填* | 明文密码（*可改用 `passwordEnc`，见下文） |
| `passwordEnc` | — | DPAPI 加密后的密码（`protect_password.ps1` 生成，优先于 `password`） |
| `serverHost` | `172.10.110.252` | 门户地址；也可写域名 |
| `portalPort` | `80` | 门户端口（非常规部署时改这里） |
| `manageAdapter` | `true` | 是否启用网卡自愈检查（`false` 时只做登录，不动网卡） |
| `defaultQueryString` | 空 | 抓不到实时重定向参数时的兜底参数 |
| `probeUrls` | 1.1.1.1 / miui / msftconnecttest | 兜底探测列表（先试 `serverHost` 本身） |
| `adapterMatch` | `Realtek PCIe 2.5GbE` | 物理网卡匹配关键字（网卡名或描述，支持子串） |
| `autoEnable` | `once` | 自动启用网卡的策略：`once` 每次开机最多自动启用一次；`always` 每次运行都启用（旧行为）；`never` 从不自动启用（仍会正常登录） |
| `oncePerBoot` | `true` | 每次开机只自动登录一次（只对 `--auto` 计划任务模式生效；手动运行永远执行） |
| `internetProbes` | connecttest.txt + generate_204 | 外网可达性校验：每项 `{"url": "...", "contains": "..."}` 或 `{"url": "...", "statusCode": 204}`；全部失败判为「未真正联网」 |
| `internetRetryCount` | `6` | v1.1.4 起：门户说在线但外网不通（常见于刚开机网关未放行）时，最多复查几次外网 |
| `internetRetryDelayMs` | `15000` | 上述复查的间隔（毫秒）；总等待时间约为 `count × delay` |
| `nicEnableWaitMs` | `60000` | 启用网卡后等待校园网 IP 的上限（毫秒） |
| `retryCount` | `3` | 登录最多尝试次数 |
| `retryDelayMs` | `15000` | 网络类失败的基础退避（毫秒，指数增长，上限 60 秒） |
| `authFailureDelayMs` | `3000` | 非网络类失败的等待（毫秒） |
| `requestTimeoutMs` | `5000` | 单次 HTTP 请求超时（毫秒） |
| `verifyAfterLoginMs` | `1500` | 登录成功后等待多久做二次校验（毫秒） |
| `service` | 空 | 运营商服务名（部分校区需要，如 `移动`/`电信`） |
| `operatorUserId` | 空 | 运营商账号（`operatorUserId` 参数） |
| `logMaxBytes` | `1048576` | 日志轮转阈值（字节） |
| `lockStaleMs` | `300000` | 锁文件判为陈旧的时间（毫秒） |

## 密码加密（推荐）

明文密码保存在 `config.json` 里，任何能读该文件的人都能看到。用 Windows DPAPI 加密：

```powershell
powershell -ExecutionPolicy Bypass -File .\protect_password.ps1
```

脚本会：备份为 `config.json.plain.bak` → 把 `password` 换成 `passwordEnc`（DPAPI / CurrentUser）→
自检解密结果 → 把 `config.json` 的 ACL 收紧到当前用户。之后：

```powershell
node .\campus_login.js --status    # 应正常输出
node .\campus_login.js --force     # 确认仍能登录
Remove-Item .\config.json.plain.bak   # 确认无误后删除明文备份
```

注意：DPAPI 绑定 Windows 用户，换用户 / 重装系统后需重新加密；`config.json.plain.bak` 含明文，不要外传。

## 网卡自动启用（自愈）说明

登录前会先检查 `adapterMatch` 匹配的物理网卡是否被禁用，分三种情况处理：

| 禁用方式 | 现象 | 恢复手段 |
| --- | --- | --- |
| 设备管理器「禁用设备」 | `Get-PnpDevice` 显示 Code 22，`Get-NetAdapter` 仍报 Disabled | `Enable-PnpDevice` |
| 「网络连接」右键禁用 | `Get-NetAdapter` 显示 Disabled | `Enable-NetAdapter`（通常也表现为 Code 22） |
| 设备管理器「卸载设备」 | 设备不在列表 | `pnputil /scan-devices` 重扫装回驱动 |

启用成功后等待 172.10.x.x 就绪；若 8 秒还没 IP，会每 15 秒执行一次 `ipconfig /renew`（最多 3 次）。
计划任务本身以最高权限运行，所以自动启用不需要额外弹 UAC；**手动运行请用管理员身份**。

### 每次开机只自动登录一次

v1.1.3 起 `CampusLogin_AutoStartup` **只在登录后 15 秒触发一次**，不再每 5 分钟重复触发
（旧版本的重试在实际使用中会反复拉起你手动禁用的网卡，也可能让脚本整晚空转）。

自动运行（`run_silent.vbs` 传 `--auto`）的规则：

1. 本次开机若还没自动执行过：先做网卡自愈 + 登录 + 外网校验，并把「本次开机已自动执行」写入 `state.json`；
2. 同一次开机内再次触发：只写一行日志「本次开机已经自动执行过登录，跳过本次触发」，直接退出；
3. 重启后 `bootId` 变化，自动失效，重新获得一次自动执行机会（无需手动清理 `state.json`）；
4. 手动运行（`run_now.vbs` / `node campus_login.js`，不带 `--auto`）不受限制，随时可以跑。
5. 例外：每天 06:10 的 `CampusLogin_Daily0610` 用 `--daily`，**不受“每次开机只跑一次”限制**——
   它负责会话过期后的每日确认，但仍会尊重你对网卡的禁用（不会偷偷启用）。

### 手动禁用的网卡不会被反复启用

自动运行还有第二层保护（`autoEnable: "once"`，默认）：区间内最多自动启用一次网卡。规则是：

1. 每次开机后，**第一次**自动运行时允许启用网卡（覆盖“开机前网卡被禁用”的情况）；
2. 之后把“本次开机已处理过网卡”记到 `state.json`（`bootHandledAt`）；
3. 你手动禁用网卡后，再手动运行时只写日志说明“尊重你的选择”，不会动网卡；
4. 需要立刻上网时手动双击 `run_now.vbs`（不带 `--auto`，始终允许启用）；下次开机恢复自动启用。

把 `autoEnable` 改成 `always` 可恢复“每次都启用”的旧行为，改成 `never` 则完全不自动启用网卡。
把 `oncePerBoot` 改成 `false` 则恢复“每次触发都尝试”的旧行为（不建议）。
`state.json` 记录 `bootId`（按系统日志里的开机事件推算，**开启“快速启动”也能正确识别**），重启后自动失效。

> 关于“快速启动”：Windows 的快速启动是“混合休眠 + 恢复”，恢复后 `os.uptime()` 和
> 系统启动时间都不会归零。若用运行时长推算开机标识，快速启动后会误判成“还是同一次开机”，
> 自动登录就会被永久跳过（表现为“开机不自动执行”）。v1.1.3 改用系统日志
> `Microsoft-Windows-Kernel-Boot` 事件 27 的启动时间戳做开机标识，快速启动也能识别为新一次开机。

### 外网可达性校验

「门户说在线」不等于「真的能上网」——门户可能回执过期、被劫持，或链路其实没通。v1.1.3 起：

1. 门户报告在线后，脚本再请求 `config.internetProbes`（默认两项：`connecttest.txt` 要求正文包含
   `Microsoft Connect Test`；`generate_204` 要求 HTTP 204），**任一项通过**才算真正联网；
2. 全部失败时不会报成功，而是返回退出码 `2`，日志写明「门户报告已在线，但外网不可达」；
3. `node campus_login.js --status` 的 JSON 里新增 `"internet":true/false` 字段，方便脚本判断；
4. 登录成功后同样做一次外网校验，防止「接口成功、实际不通」的假成功。

**v1.1.4 起：刚开机「门户假在线」会自动等待恢复。** 刚开机时认证网关常常还没放行数据面：
门户回执显示已在线，但外网被劫持/不通，此时立即重登也没有意义（门户认为你在线，抓不到实时参数）。

5. 遇到「门户在线 + 外网不可达」时，先尝试一次门户注销（`method=logout`）重置旧会话；
6. 然后按 `internetRetryCount` × `internetRetryDelayMs`（默认 6 次 × 15 秒）耐心复查外网：
   - 外网恢复 → 直接算成功（退出码 0，日志「外网已恢复可达」），不发起多余登录；
   - 门户转为离线（注销生效）→ 自动重新抓参数认证登录；
   - 始终不通 → 退出码 2，日志说明可能卡在网关侧，稍后重新运行即可。
7. 因此刚开机时手动双击 `run_now.vbs` 可能等 1~2 分钟才弹结果，这是正常的“等网关放行”。

## 计划任务

`setup_tasks.ps1` 注册两个任务（均 `RunLevel Highest`、隐藏窗口、单实例 `IgnoreNew`）：

| 任务 | 触发 | 说明 |
| --- | --- | --- |
| `CampusLogin_AutoStartup` | 登录后 15 秒，**每次开机只触发一次** | 开机自动连；脚本内部会等 DHCP、必要时续等 IP |
| `CampusLogin_Daily0610` | 每天 06:10（唤醒计算机，动作带 `--daily`） | 防止会话过期 |

任务动作是 `wscript.exe run_silent.vbs`（不经过 cmd.exe，因此不会有 0xc0000142 弹窗）；
`run_silent.vbs` 传给脚本的参数是 `--auto --quiet`：
`--auto` 同时启用「每次开机只自动登录一次」（`oncePerBoot`）与「每次开机最多自动启用一次网卡」
（`autoEnable: once`）两层保护——手动运行（`run_now.vbs` / `node campus_login.js`）不带该参数，
不受这两层限制，随时可以立刻登录。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 登录成功，或本来就已在线；也用于「已有实例在运行，本次跳过」 |
| `1` | 登录失败（认证被拒 / 重试用尽 / 二次校验未通过） |
| `2` | 网络未就绪（拿不到 172.10.x.x 或一直不可达）；也用于「网卡被你手动禁用，自动任务尊重该选择并跳过」；v1.1.3 起还用于「门户说在线但外网实际不可达」（v1.1.4 起会先自动等待复查约 90 秒再下结论） |
| `3` | 配置错误（缺字段、JSON 损坏、密码解密失败） |

## 常见问题

**双击后弹出 `cmd.exe - Application Error (0xc0000142)`**
说明 cmd.exe 自身初始化失败（与本项目逻辑无关）。用 `run_now.vbs` 启动，或直接用
`node campus_login.js`，都不经过 cmd.exe。

**日志说「物理网卡未被禁用，但暂未获取到校园网 IP」**
网卡是启用的但 DHCP 还没下发地址（常见于刚开机）。脚本会自动刷租约并继续等；
若长期如此，检查网线 / 交换机端口，或跑 `node nic_ctl.js --diag` 看网卡与 IP 详情。

**我手动禁用了网卡，为什么计划任务没有再自动启用它？**
这是有意行为（v1.1.1 起）：自动任务每次开机只跑一次、最多自动启用一次网卡，之后会尊重你的手动禁用
（日志会写「尊重该选择」）。想立刻上网就双击 `run_now.vbs`；若希望每次触发都强行启用网卡，把
`config.json` 里的 `autoEnable` 改成 `"always"`。

**为什么每次开机只自动登录一次？**
v1.1.3 起去掉了「每 5 分钟重复触发」：重复触发在实际使用中会反复拉起你手动禁用的网卡，也会让脚本
空转整晚。现在的设计是登录后 15 秒执行一次，脚本内部自己等 DHCP（最多 60 秒）并在必要时刷新租约，
失败也不再重排。需要重试时手动双击 `run_now.vbs` 即可。想恢复旧行为把 `oncePerBoot` 设为 `false`。

**双击后弹窗提示「网络还没有真正就绪（返回码 2）」/ 日志写「门户报告已在线，但外网不可达」**
说明门户回执说在线，但真实外网探测（`connecttest.txt` / `generate_204`）没通过，通常意味着：
① 会话其实已被门户下线；② 需要重新认证；③ 网络被劫持或 DNS/出口异常。
这不是脚本误报，而是「不要假装连上了」。手动双击 `run_now.vbs` 重新走一遍认证；也可
`node .\campus_login.js --status` 看 `online` 与 `internet` 两个字段。

**日志报「门户对 pageInfo 返回空响应」，然后退出码 1**

这是 v1.1.1 及更早版本的已知问题，v1.1.2 已修：门户其实已经在线（或会话还挂着）时，
它不会再下发新的 `queryString`，旧逻辑却把「在线探测失败」当成「未登录」去登录，于是报错。
现在判定在线会综合三条信号（`userIndex` JSON、`redirectortosuccess` 302、门户根路径 302），
`pageInfo` 空响应时还会复核一次在线状态，确认在线就直接成功退出（退出码 0，不再弹错误框）。
如果确实离线却仍报这个错，多半是 `defaultQueryString` 过期：把它清空（`""`），
脚本会重新抓取实时参数。

**日志出现「已有另一个登录实例在运行，本次跳过」**
说明上一次还在跑（或锁文件残留）。等几分钟重试；确认没有 node 进程时可删除
`campus_login.lock`。

**计划任务显示运行成功（LastTaskResult=0），但日志里没有新记录**

v1.1.1 及更早版本的 `run_silent.vbs` 是以 UTF-8（无 BOM）保存的，WSH 会按 ANSI 解析，
个别环境下 `ws.Run` 不报错却没有启动 node，表现为「任务成功、什么也没发生」。v1.1.2 起
已改为 UTF-16LE（带 BOM）保存。若你手工改过 `run_silent.vbs`，请务必用「UTF-16 LE with BOM」
保存，否则可能又变成静默空转。

**在哪里看历史记录？**
`campus_login.log`（超过 1 MB 自动轮转为 `campus_login.log.1`，只保留一份历史）。

**怎么彻底卸载？**
管理员 PowerShell 运行 `uninstall_tasks.ps1`，再删除项目目录与桌面快捷方式即可。

## 开发与测试

```powershell
npm run check   # 语法检查
npm test        # node:test 单元测试 + 假门户集成测试（零依赖，共 51 个用例）
npm run diag    # 网卡 / PnP / IP 诊断
```

> 如果本机 PowerShell 禁止运行 `npm.ps1`（`PSSecurityException`），改用 `npm.cmd run check`
> 或直接 `node --test "test/*.test.js"`。

测试分两类：`test/*.test.js` 覆盖配置合并、参数解析、锁、错误分类、日志轮转、RSA 加密、
「每次开机只跑一次」状态机与外网校验等纯逻辑；`test/login_flow.test.js` 在本机随机端口起一个
**假门户**，完整跑通「抓实时 queryString → 登录 → 二次校验成功」以及认证被拒、二次校验失败、
无参数回落等失败路径（不依赖真实校园网）。

CI：GitHub Actions `windows-latest`，Node 18/20/22 跑语法检查与单元测试。

## 安全提示

- `config.json`、`campus_login.log`、`config.json.plain.bak` 已在 `.gitignore` 中，不要提交。
- `push_to_github.bat` 可能包含 GitHub 凭据，同样被忽略；发布前务必检查。
- 建议执行一次 `protect_password.ps1` 去掉明文密码。
- `security.js` 为锐捷官方 RSA 库（第三方），仅做加载，不做修改。

## 更新记录

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

MIT

# Campus Network Auto Login (锐捷校园网自动登录与定时连接套件)

本项目是一个专为 Windows 平台打造的校园网自动化登录脚本套件，针对**锐捷（Ruijie eportal）**网页认证系统定制。支持**开机静默自动连接**与**每日早晨定时自动连接（如 06:10 宿舍恢复供网）**。

---

## 特性亮点

- **原生 RSA 协议还原**：基于锐捷官方加密算法，密码与客户端 MAC 拼接加密，100% 模拟网页端认证行为。
- **代理 / TUN 虚拟网卡穿透**：针对开启科学上网代理客户端（TUN 模式）导致校园网内网服务器连接超时的问题，脚本强制绑定本机的校园网物理网卡 IP（`172.10.x.x`），确保直连畅通。
- **智能网络状态感知**：开机或定时触发时先探测是否在线，已在线则静默秒退，不产生多余请求。
- **静默后台执行**：通过 VBScript 宿主包装，开机自启或定时触发时**完全不弹黑色命令行窗口**。
- **开箱即用定时任务**：内置 PowerShell 脚本，一键注册 Windows 原生任务计划程序。

---

## 目录结构

```text
├── config.example.json     # 配置文件模板（首次运行请复制为 config.json）
├── campus_login.js         # 核心登录与状态检测主程序
├── network_client.js       # 网络客户端（物理网卡探测与绑定）
├── rsa_util.js             # 官方 RSA 加密模块桥接
├── security.js             # 锐捷官方 RSA 密码运算逻辑
├── run.bat                 # 手动双击运行/调试测试脚本
├── run_silent.vbs          # 静默后台调用脚本（计划任务调用）
├── setup_tasks.ps1         # Windows 计划任务一键安装脚本
├── uninstall_tasks.ps1     # Windows 计划任务一键卸载脚本
├── LICENSE                 # MIT 开源许可证
└── README.md               # 项目使用说明文档
```

---

## 快速开始

### 1. 准备运行环境
本项目依赖 [Node.js](https://nodejs.org/)（建议 Node.js 18+ 或最新 LTS 版本）。

### 2. 配置账号信息
将 `config.example.json` 复制一份并重命名为 `config.json`：
```bash
copy config.example.json config.json
```
打开 `config.json` 并填入您的信息：
```json
{
  "userId": "你的学号或账号",
  "password": "你的密码",
  "serverHost": "172.10.110.252",
  "defaultQueryString": "wlanuserip=...（未登录时浏览器弹出的完整URL中问号后面的参数）",
  "retryCount": 3,
  "retryDelayMs": 5000
}
```
> **注意**：`config.json` 已被加入 `.gitignore`，不会被提交或泄露到远程仓库。

### 3. 手动测试运行
- 双击运行 `run.bat`，即可测试当前连接状态。
- 如需强制向网关发起登录测试：
  ```bash
  node campus_login.js --force
  ```

### 4. 注册 Windows 自动任务
以管理员身份运行 PowerShell，在项目根目录下执行：
```powershell
powershell -ExecutionPolicy Bypass -File .\setup_tasks.ps1
```
注册成功后，Windows 任务计划程序中将增加两个任务：
1. **`CampusLogin_AutoStartup`**：开机进入桌面后延迟 15 秒（等待物理网卡连接并获取 IP）自动静默运行；
2. **`CampusLogin_Daily0610`**：每天早晨 **06:10:00** 准时唤醒并自动静默连接。

如需卸载移除任务计划，执行：
```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall_tasks.ps1
```

---

## 免责声明

本脚本仅用于个人学习、自动化提升效率之目的，请勿用于违反校规或攻击校园网网络的用途。使用本项目所产生的一切后果由使用者自行承担。

## 开源协议

本项目采用 [MIT License](LICENSE) 许可协议。

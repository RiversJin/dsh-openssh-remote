[English](./README.en.md) · **中文**

---

# dsh-remote

[![npm version](https://img.shields.io/npm/v/dsh-remote)](https://www.npmjs.com/package/dsh-remote)
[![downloads](https://img.shields.io/npm/dw/dsh-remote)](https://www.npmjs.com/package/dsh-remote)
[![downloads](https://img.shields.io/npm/dm/dsh-remote)](https://www.npmjs.com/package/dsh-remote)
[![license](https://img.shields.io/github/license/flymysql/dsh-remote)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-7a3ef3)](https://github.com/topics/dsh-plugin)

由 [@flymysql](https://github.com/flymysql) 维护 · [主页](https://flymysql.github.io/dsh-remote/) · [用量统计](https://flymysql.github.io/dsh-remote/stats/) · [博客](https://gitpull.cn) · [讨论区](https://github.com/flymysql/dsh-remote/discussions) · [Issue](https://github.com/flymysql/dsh-remote/issues) · [English](./README.en.md)

![dsh-remote —— 把任意 SSH 机器变成真正的 DSH 工作区](docs/cover.png)

**为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打造的远程工作助手。**

维护多台 SSH 机器，然后在「选择工作区」时选一个**远程工作区**（或**本地工作区**），Agent 就能在不离开 harness 的情况下直接操作——列文件、读代码、在远程主机上跑构建/命令，并把远程目录镜像成一个真实的本地工作区对象。

DSH 的 Web 界面刻意只监听 `127.0.0.1`（CLI 为安全拒绝 `--host 0.0.0.0`）。本插件反过来：**由你主动连出**到你维护的机器，选一个工作区，然后通过 DSH 原生的工作区 + 文件流来工作——**不改动 `dsh-workspace` 核心**。

## 数据采集 / 遥测

dsh-remote 每次启动会发送**一次匿名心跳**（同一安装最多每 6 小时一次），用于统计真实使用量：去重日活、实际在跑的版本、平台分布。npm 下载量回答不了这些问题（由发版驱动、且含镜像与爬虫），GitHub clone 也混有 CI。

**发送的内容** —— 严格只有 5 个字段，一个都不多：

| 字段 | 示例 | 用途 |
|---|---|---|
| `idHash` | `872bd8cf…`（32 位 hex） | `HMAC-SHA256('dsh-remote/telemetry/v1', installId)`，本安装的伪名 |
| `version` | `0.8.29` | 实际在运行的版本 |
| `platform` | `win32` / `darwin` / `linux` | 平台分布 |
| `arch` | `x64` / `arm64` | 架构 |
| `node` | `24.14.0` | Node 版本 |

**绝不发送** —— 主机名、用户名、文件路径、IP、SSH 主机/端口/密钥、你的机器列表、会话内容、任何远程工作区数据。本插件恰恰能拿到这些信息，所以边界在这里划得很硬：原始 `installId` **不离开本机**，只有它的 HMAC 被传出，服务端无法与其他数据关联，也无法反推身份。

**身份存放位置** —— `<DSH_HOME>/.dsh-remote-install-id`（如 `~/.dsh/`）中的一个随机 UUID。刻意**不放在插件目录**：npm/pnpm 每次升级都会覆盖插件目录，放那里会让同一台机器每次升级都换身份，把 1 个用户算成 N 个。删除该文件即重置身份。

心跳是**尽力而为**的旁路：不阻塞加载、不产生日志噪音、任何失败（离线/被拦截/端点变更）都静默吞掉，绝不影响插件的任何功能。

[实时用量看板](https://flymysql.github.io/dsh-remote/stats/) · [插件主页](https://flymysql.github.io/dsh-remote/)

## 界面预览

设置 → **远程工作区** —— 多机 SSH 列表（增/删/改/设为当前，密码本地保存、不回显）：

<img src="docs/ui-settings-panel.png" alt="dsh-remote 设置页 — 多机列表（浅色主题，主机已打码）" width="720"/>

原生 **「Add workspace / 选择工作区」** 流程 —— **居中弹窗**、两个 tab，**默认落在「本机」**；切到 **「远程」**：

- **远程** —— 一个**机器下拉**；路径输入框**自动预填 `/` 并实时补全目录**（点选一个目录后**立即列出它的下一级**，像系统/VSCode 逐级选目录）；另外有**「浏览…」浮窗**，选中仅回填到输入框（不直接提交），你复核 / 修改后点「设为远程工作区」。

真实截图（机器已打码为占位）：

<img src="docs/ui-picker-panel.png" alt="dsh-remote 工作区选择 — 真实弹窗；默认本机 tab；远程：机器下拉 + 预填根路径 + 自动补全" width="720"/>

---

## 功能

- **多机 SSH** —— 可存任意多台主机（host/port/user + **私钥**或**密码**）。密码只存在本地，界面不回显；在设置里一键切当前机。每机可配 passphrase / 主机指纹策略 / SSH agent / keyboard-interactive（OTP）/ 跳板机，以及可选的 **系统钥匙串加密密码**。
- **`~/.ssh/config` 别名（实时解析，不存副本）** —— 机器可以只保存一个 **Host 别名**（`useSshConfig`）：主机名/用户/端口/私钥/跳板机**每次连接都从 `~/.ssh/config` 实时解析**，改配置立刻生效、无需重新导入；注册表里**不存这些值的副本**（私钥只引用路径，永不读内容）。支持 OpenSSH 语义：`Host a b` 多别名、`*`/`?` 通配、`!` 取反、`Include`（含通配、相对 `~/.ssh`）、行尾 `\` 续行、以及 ssh_config(5) 的**首个取值优先**规则。设置页「从 ~/.ssh/config 导入」列表里点别名即按别名保存（也可以「复制字段」成普通机器）；列表与机器行都会显示 **别名 → 实际解析到哪台机**，`ProxyJump` 多跳、`ProxyCommand` 等插件无法照做的事会**显式告警**而不是静默降级。
- **双 tab 工作区选择器**（填充原生「Add workspace」流程）：
  - **本机** —— 走 **host 端原生系统文件夹对话框**选本地目录（或直接输入本地路径）→ 直接成为普通 DSH 本地工作区（与本地工作区共存）。优先用 DSH 的 `directoryPicker` 服务，服务缺失时**回退到插件自持的原生选择器**（macOS `osascript` / Linux `zenity`→`kdialog` / Windows `FolderBrowserDialog`）——桌面启动路径上框架服务不注册也能用。
  - **远程** —— 选择器是**居中弹窗**（窄侧边栏也不会被挤压）。先**选机器** → Windows 主机根级显示 **「此电脑」多盘视图**（`C:\`、`D:\`、`E:\`…，而不是 Git Bash 的 MSYS 根），路径框**实时补全**目录（支持 `C:\Users\…` 或 `/c/Users/…` 任意写法，Windows 路径在底层自动改写为 Git Bash 形式）；**选中一个目录立即列出它下一级**（OS/VSCode 式级联）。另有 **「浏览…」文件选择式浮层**（Windows 面包屑 `此电脑 / C:\ / Users / dev` 可点击跳级、驱动器行、大小/时间、跟随软链），选中**回填输入框不提交**，你复核/修改后再确定；「回上一级」任意深度可用（包括浮层直接打开在路径栏当前路径时）。**最近工作区**快捷入口、**`~` 主目录**、**新建目录**一键可达。确定会创建**真实本地镜像**（`$DSH_HOME/remote-workspaces/<host>-<user>-<port>/<basename>`；仅当同主机上**别的远端路径**已占用同名 basename 时才追加短路径 hash）→ harness 把它当真实工作区收养，同时 dsh-remote 通过 SFTP 保持同步。所选工作区会**持久化到该机器**，重启不丢。
- **Git Bash 默认终端（Windows 主机）** —— 自动探测远程平台（`cmd /c ver`，附 `uname -s` 的 MINGW/MSYS 探测兜底）；Windows 机器自动定位 Git Bash（`config.shell` 可显式指定或 `native` 关闭），所有命令经 `bash -s` 从 SSH 通道 stdin 管道执行，不依赖 cmd/PowerShell，也不受引号/反斜杠转义困扰；`rw_exec` 默认在 Git Bash 形式的 cwd（`/c/Users/…`）下执行。`/dsh-remote/status`、`rw_info`、设置页「测试连接」都会报告检测到的平台与 shell。
- **Windows 路径自动改写** —— 用户输入 `C:\Users\dev\project`（或 `C:/…`、`/c/…`、`/C:/…`）时底层自动规范为 Git Bash 形式 `/c/Users/dev/project` 执行；工作区存储与展示为 Windows 形式 `C:\Users\dev\project`。模型工具全部接受并展示两种写法；SFTP 访问使用 Win32-OpenSSH 的 `/D:/…` 形式（见 `toSftpPath`）。
- **远程 `@` 补全（issue #39）** —— 远程会话里输入 `@` 会**列出远端目录树**（走 SFTP 实时读，不是本地镜像）。目录逐级下钻、无斜杠时在整棵树上模糊匹配，候选是**相对远程工作区根的路径**（`@src/main.c`），与本地会话的写法一致；`rw_*` 工具接受这种相对路径并自动拼到远程工作区根上。索引有预算保护（条目/目录/时限 + 缓存 + 失败熔断），**远端不可达时自动回退到本地镜像**（不会静默变成空列表）。本地会话完全不受影响。
- **双向 SFTP 同步（三路冲突检测）** —— `rw_sync`（远程→镜像）、`rw_push`（镜像→远程）。两边都改过的文件会列出冲突、绝不静默覆盖（`force=true` 覆盖）。默认 **深度 8 / 2000 文件**，触顶会标明 **`TRUNCATED`**。支持 dry-run、后台任务、gitignore 风格 ignore 规则。
- **模型工具（20 个）** —— `rw_info`、`rw_connect`（可 `save`）、`rw_pick_workspace`、`rw_list_dir`（大小+mtime）、`rw_stat`、`rw_read_file`（utf-8/gbk）、`rw_write_file`、`rw_edit`（字面替换 + mtime 乐观锁）、`rw_append`、`rw_mkdir`、`rw_remove`（递归、有上限）、`rw_move`、`rw_exec`（pty/env）、`rw_search`（**POSIX 快路径 `rg` → `grep -R -E`，远端两者都没有时回退 SFTP 遍历**，因此 Windows 主机也可用；遵守 ignore 规则、支持上下文行）、`rw_download`/`rw_upload`（流式 fastGet/fastPut + 体积上限）、`rw_forward`（SSH 隧道）、`rw_sync`、`rw_push`、`rw_disconnect`。
- **端口转发面板** —— 设置页或 `rw_forward` 创建/启停/删除**本地**（`127.0.0.1:port → 远端`）与**反向**（`远端 → 本地`）隧道；定义持久化，开启时重连自动恢复，断开时全部停止。
- **侧栏远程编辑** —— 远程文件 tab 可编辑并保存到远端（mtime 乐观锁，冲突返回 409 + 「重新读取」）。**v0.8.19** 起文件操作按会话绑定机器（前端带 `sessionId`），两台不同主机的会话不会共用当前机连接池。文件树显示文件大小，并有**右键菜单**（下载到本地镜像 / 重命名 / 删除 / 新建目录）。
- **命令审计** —— 每次 `rw_exec`/写/删/移动/转发都追加到 `$DSH_HOME/remote-workspaces/audit.log`（时间 · user@host · 操作 · 退出码 · 命令）；设置页显示最近 30 条。
- **长任务异步化** —— `rw_sync`/`rw_push` 传 `async: true` 返回 `taskId`，通过 `/dsh-remote/task` 查询进度/结果/取消（单飞队列）。
- **连接体检** —— 设置页「测试连接」按类别提示（认证 / 网络 / 主机指纹 / 超时）；延迟会缓存在机器记录里。
- 当前 `user@host:/path`（以及生效的转发）会注入每次系统提示，让 Agent 明确自己的工作根。
- **不改任何 `dsh-workspace` 官方代码** —— 全部作为普通插件实现（client 半以 `priority -100` 填充 directory-flow holes）。
- **远端跨平台** —— 文件访问走 SFTP 协议（不依赖 POSIX shell），Linux/macOS/Windows 远端都能列/读/写/搜索/同步。
- **主机指纹校验（TOFU）** —— 每次 SSH 连接都校验主机密钥（`hostKeyMode: accept-new`）：首次连接记录，之后**密钥一旦变化立即拒绝**（防中间人）。`verify` 模式还会拒绝从未见过的机器；`off` 关闭校验。指纹存于 `$DSH_HOME/remote-workspaces/known_hosts.json`；误判可用 `/remote forget-key` 重置。
- **数据跟随 Harness 根目录** —— 机器清单与镜像放在 `$DSH_HOME/remote-workspaces`（桌面版即 `userData/harness` 下）；0.6 之前落在 `~/.dsh/remote-workspaces` 的数据**首次启动自动迁移**，不丢失。

## 安装

### DSH 版本兼容性

`dsh-remote` **同时支持 `0.1.x` 与 `0.2.x` 两条 DSH 线**。自 **0.8.29** 起，所有
`@deepseek-ai/dsh-*` 的 peer 范围都是**跨线区间**（`>=0.1.0-rc.6 <0.3.0`，其中三个
`dsh-client-*` 保持各自原有的 `>=0.1.2-rc.1` 下界），而不再是 caret。

这一点的必要性在于：DSH 会在导入 bundle **之前**，把每条 `@deepseek-ai/dsh` /
`@deepseek-ai/dsh-*` 的 peer 范围与运行时版本比对，**只要有一条不匹配就整包丢弃**：

```
dsh: skipping profile bundle "dsh-remote": Error: Plugin dsh-remote@… is incompatible …
```

而 caret 在 `0.x` 上会锁死该小版本线，所以 `^0.1.0-rc.6` 永远无法容纳 `0.2.x` 运行时，
`^0.2.0-rc.1` 也永远无法容纳 `0.1.x`。**如果你用的版本低于 0.8.29，请升级**——若你在升级
DSH 后插件整个消失（没有设置页、没有 `rw_*` 工具），原因就是它。
`test/compat.test.js` 用 DSH 自己的判定谓词钉住这些范围，防止 caret 回潮。

### 官方 Desktop 兼容适配（实验性，尚未发布）

本分支增加对 [DeepSeek 官方 Desktop](https://github.com/deepseek-ai/deepseek-harness)
的适配，以 `0.1.5-rc.2` Host 通信协议验证，不修改 Harness 核心：

- 通过 `ctx.connection.fetch` 注册 `/api/dsh-remote/*`，由 Desktop 的
  `dsh-app:` 通道承载请求，鉴权仍由宿主负责，不启动 Web Server。
- 通过 `sidebarRightTabs` 和 `sidebar.right.pane.tab` 提供原生“远程文件”入口，
  复用原来的文件树与编辑器，不把远端路径传给本地文件预览器。
- `dsh-better-sidebar` 不再内置；Web 版可以单独安装，官方 Desktop 则使用
  原生右侧栏集成。

已验证 Host 启动、IPC 请求、真实 SSH 的只读连接/目录列表/文本读取，以及设置页和
测试 SSH 配置的导入。**v0.8.19** 起侧栏 `/ls` `/read` `/write` `/fs` 在请求带
`sessionId` 时按该会话的镜像绑定选机（与 `rw_*` 同一套），不再落到「当前机器」
连接池；宿主侧测试覆盖双机会话路由与编辑 409/重读/保存。原生文件标签的完整 GUI、
失败/取消交互、非 macOS 宿主以及旧 Web 版完整 UI 回归仍属实验性。

Desktop 安装器还可能要求明确配置 `ssh2` / `cpu-features` 可选构建脚本策略。
隔离验证中禁用了这些可选脚本；本改动不放宽应用的构建白名单，也不自动批准脚本。

### 已发布的 Web bundle

```bash
dsh plugin add dsh-remote            # 添加 bundle
```

从 **v0.8.18** 起，`dsh-remote` 只安装并挂载自身。Web 侧边栏
（[dsh-better-sidebar](https://www.npmjs.com/package/dsh-better-sidebar)）
改为可选，不再是依赖，也不会被自动挂载。这样 SSH 工具和设置页不再被某个侧边栏
实现的版本/API 变化拖垮。

如需 Web 版远程文件浏览/编辑，请显式安装两个 bundle：

```bash
dsh plugin add dsh-remote
dsh plugin add dsh-better-sidebar
```

独立侧边栏 service 存在时，`dsh-remote` 会动态发现它并注册远程文件 tab；
不安装时，`rw_*` 工具、设置页、同步、审计日志和端口转发均照常工作。
官方 Desktop 使用原生右侧栏，不需要安装 `dsh-better-sidebar`。

> **从 0.7.2–0.8.17 升级：** 升到 0.8.18 后，内嵌侧边栏依赖和挂载会消失。
> 只有仍需要 Web 侧边栏 UI 时才单独安装 `dsh-better-sidebar`。旧 profile 里针对
> `id: dsh-remote-sidebar` 的覆盖可以删除，因为这行已不存在。

（或 `npm install dsh-remote`，再在 `cordis.patch.yml` 加 `- id: dsh-remote / name: dsh-remote`。）

## 快速上手

1. **加一台机器** —— 设置 → 远程工作区 → 填 host/port/user + 密码或 key →（可选）设为当前。
   > **保存 ≠ 激活（v0.8.8+）**：保存的机器只是备用连接，不会自动进入任何 session 的
   > remote context。只有「设为当前」（或 Agent 显式调用 `rw_connect`）才激活当前机器；
   > 「取消设为当前」可回到 `active remote = none`。
2. **选工作区** —— 点侧边栏/会话的 **Add workspace**：
   - **本机** → 系统文件夹选择（或输入本地路径）→ 本地工作区。
     宿主没有可用的系统对话框时（DSH Desktop 的 browse 后端、无 zenity/kdialog 的无头
     SSH 主机），改为弹出插件内置的目录浏览器——面包屑、Windows 盘符切换、新建目录、
     选中回填。
   - **远程** → 选机器 → 浏览到远程目录（或输入 `/path`）→ 「设为远程工作区」⇒ 创建并收养一个本地镜像工作区。
3. **让 Agent 工作** —— 把它当普通工作区用：
   - `rw_list_dir(path?)` / `rw_read_file` / `rw_stat` —— 查看远程文件
   - `rw_write_file` / `rw_edit` / `rw_append` —— 创建、补丁、追加远程文件
   - `rw_mkdir` / `rw_remove` / `rw_move` —— 管理远程路径
   - `rw_search(pattern, path?)` —— 远程 grep（POSIX 走 rg/grep，否则 SFTP 遍历）
   - `rw_exec(command, cwd?, pty?)` —— 在远程执行命令（默认在工作区目录）
   - `rw_forward` —— SSH 隧道
   - `rw_sync` / `rw_push` —— 冲突感知的镜像拉取/推送

> **Remote context 是 session 级的（v0.8.8+）**：system prompt 只会在**当前 session 的
> cwd 位于某个远程 mirror 内**（即你把远程目录选成了这个 session 的工作区）时注入
> 「Remote workspace」段落；普通本地 session 不注入、侧边栏「远程文件」也不显示任何
> 机器默认目录，模型不会主动调用 `rw_*`。混合访问（本地 + 远程同屏比较）请通过显式
> 选择远程工作区进行。

## 可选：CLI 默认机

可在 `cordis.patch.yml` 提供默认机：

```yaml
# 示例：请换成你自己的机器
- id: dsh-remote
  name: dsh-remote
  config:
    host: 203.0.113.10   # 或你的真实主机 / hostname
    port: 22
    username: dev
    privateKeyPath: ~/.ssh/id_rsa
    # 或用密码登录：
    # password: '…'
    workspace: ~/project
```

若 `host` 为空，插件启动时处于断开状态，在 UI 里配置机器即可。

## 常用命令（安装 / 查看 / 启动）

DSH 的 `dsh` 可能不在某些 shell 的 PATH（比如 Windows PowerShell 里在某个仓库目录下），所以同时列出 `dsh` 与 `npx` 两种写法。操作都要用 `--profile <name>` 指定 profile（一般 `web`）：

```bash
# 安装（从 npm 拉到 profile）
dsh plugin --profile web add dsh-remote
# 同一效果：当 `dsh` 不在 PATH 时用 npx
npx --yes @deepseek-ai/dsh plugin --profile web add dsh-remote

# 确认已装
dsh plugin --profile web list
npx --yes @deepseek-ai/dsh plugin --profile web list

# 启动 web 界面（重载 profile，新插件在启动时生效）
dsh --profile web
npx --yes @deepseek-ai/dsh --profile web   # 访问 http://127.0.0.1:3080

# 迭代用本地源码替换 npm 版（便于改 dsh 插件代码后即测）
npx --yes @deepseek-ai/dsh plugin --profile web add D:/path/to/dsh-remote
npx --yes @deepseek-ai/dsh plugin --profile web remove dsh-remote   # 恢复用发行版
```

启动成功后，设置 →「远程工作区」会出现；「Add workspace」流程会带「本机 / 远程」两个 tab（见上方效果图）。

## 开发（沙箱优先，勿改产品）

迭代**一律在沙箱**里做，绝不手工改产品 profile——产品 profile 由插件管理器重管，
重装会把手工部署的文件还原掉。用仓库内的辅助脚本：

```bash
scripts/dev-run.sh --restart   # 启动 / 重启隔离沙箱
scripts/dev-run.sh --stop      # 停止
scripts/dev-run.sh --status    # 是否在运行
```

- 自带一套独立 DSH 实例（仓库内 `dev-harness/harness`），把 `lib/` 复制进沙箱
  profile——与桌面 App 走同一条 `bin.js web --patch` 启动路径，沙箱即产品启动行为。
- 沙箱 web UI 在 `http://127.0.0.1:50599`，插件路由立即可见（如
  `GET /dsh-remote/machines`）。
- **宿主半改动**（`lib/index.js`）需重启沙箱（`--restart`）；**客户端半改动**
  （`lib/client.js`）只需刷新页面。
- Node ESM 按导入文件的真实路径解析依赖，脚本用**硬链接拷贝**（`cp -al`）把
  `lib/` 复制进沙箱 profile，而不是软链——软链会破坏 `@deepseek-ai/*` 的解析。
- 每次提交前跑 `node check.mjs`（静态框架约束闸门：命令名正则等）；
  `scripts/boot-smoke.sh` 用隔离实例证明插件仍能启动。
- 完整规则见 `scripts/dev-standards.md`（命令名、cordis 服务只许 `ctx.get()`、
  可选框架服务可能压根不注册、三方库回调契约以真实运行为准等）。

部署到产品 profile 是单独的受控动作（`./sync.sh`），只在确定要发布时做。

## 配置

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `host` | string | `''` | 默认 SSH 主机（空=断开） |
| `port` | int | `22` | 默认 SSH 端口 |
| `username` | string | `''` | 默认 SSH 用户 |
| `password` | string | `''` | 默认 SSH 密码（非空覆盖 key） |
| `privateKeyPath` | string | `''` | 私钥路径（仅在显式提供时使用） |
| `passphrase` | string | `''` | 加密私钥的 passphrase |
| `workspace` | string | `''` | 默认远程工作区路径 |
| `shell` | string | `''` | 远程命令终端策略：`''`=自动检测（Windows 找 Git Bash）、`'git-bash'`=优先 Git Bash、`'native'`=不包装、其他=显式 bash.exe 路径（如 `C:\Program Files\Git\bin\bash.exe`） |
| `commandTimeoutMs` | int | 20000 | 单条远程命令超时 |
| `connectTimeoutMs` | int | 15000 | SSH 连接超时 |
| `maxOutputChars` | int | 200000 | 单条远程命令捕获的 stdout/stderr 上限 |
| `maxFileBytes` | int | 52428800 | 镜像同步时跳过超过该大小的文件（0=不设上限） |
| `hostKeyMode` | string | `accept-new` | 主机指纹策略：`accept-new`（首次信任）、`verify`（拒绝未知主机）、`off`（跳过校验） |
| `useAgent` | bool | `false` | 用 OpenSSH agent（`SSH_AUTH_SOCK`）认证 |
| `keyboardInteractive` | bool | `false` | 允许 keyboard-interactive 认证（OTP/MFA）并复用配置的密码 |
| `proxy` | object | — | 跳板机：`{ host, port?, username?, password?, privateKeyPath? }` |
| `autoPush` | bool | `false` | 镜像内文件被编辑后自动推回远端（watcher，带防抖） |
| `auditLog` | bool | `true` | 把执行的命令追加到 `$DSH_HOME/remote-workspaces/audit.log` |
| `encoding` | string | `utf-8` | 远程文件读写的文本编码（如 `gbk`） |
| `fileReference` | bool | `true` | 远程 `@` 补全：远程会话的 `@` 列出**远端**目录树（issue #39）；关闭则只有本地镜像 |
| `fileReferenceMaxResults` | int | `20` | 一次 `@` 查询最多返回多少候选 |
| `fileReferenceMaxEntries` | int | `3000` | 一棵远程工作区索引最多保留多少条目 |
| `fileReferenceExcludedDirectories` | string[] | `[.git, node_modules, dist, build, out, coverage, target, .next, .nuxt, .turbo, .venv, __pycache__, .pytest_cache, .mypy_cache, .gradle]` | 远程 `@` 遍历跳过的目录名 |
| `fileReferenceTimeoutMs` | int | `4000` | 一次远程索引遍历的墙钟预算（超时用已扫到的部分结果，不让光标等） |
| `updateMode` | string | `auto` | 自更新模式：`auto`=加载时及每 6 小时检查并自动应用、`manual`=仅在手动检查时查、`off`=完全不查。**0.8.27 起默认 `auto`**——之所以现在才安全，是因为 0.8.24 补上了宿主半热切换 |
| `updateCheckIntervalMs` | int | 21600000（6h） | `auto` 模式检查 npm 的间隔（下限 60000） |
| `updateAutoReload` | bool | `true` | 更新落地后自动热切换宿主半；`false` 则留到下次启动，设置页会显示 `pendingReload` |

> 权威清单是 `lib/index.js` 里的 `Config` schema，本表与之一致。

## 常见问题 / 排查

**`@` 能列出远程文件，但内置的读文件工具打不开** —— harness 自带的文件工具看到的是会话的**本地镜像**（`$DSH_HOME/remote-workspaces/…`），要等 `rw_sync` 下载后才有内容。读远程文件请用 `rw_read_file` 或侧栏的远程文件 tab：远程会话里的 `@src/main.c` 指 `<远程工作区>/src/main.c`，所有 `rw_*` 工具会把这种相对路径解析到远程工作区根。完全看不到候选？远端不可达时 `@` 索引会回退到本地镜像，设置页「测试连接」会告诉你原因。

**主机指纹变了 / 提示可能中间人** —— 主机重装过或密钥更换过：`/remote-forget-key`（或设置页 → 机器 → 重新信任），下次连接重新记录。

**连接报「认证失败」** —— 检查用户名/密码/私钥路径；私钥加密了要填 Passphrase；公司机器要求 OTP/动态码时勾选 keyboard-interactive。

**连不上内网机器** —— 走跳板机：机器表单里填「跳板机」主机（也可以先把它本身配成一台机器）。主机不可达类错误会给出分类提示。

**`rw_sync`/`rw_push` 报冲突** —— 远端和本地都改过同一个文件时会跳过并列出冲突（绝不静默覆盖）。处理：手动合并后重新同步，或用 `force=true` 以一边为准。

**Windows 远程** —— 列表/读写/搜索/同步全部走 SFTP 协议，不依赖 POSIX shell；中文文件用 `encoding=gbk` 读。

**镜像里没有某个目录** —— 默认 ignore 规则（`.git`、`node_modules`、`target` 等）会跳过；在 `$DSH_HOME/remote-workspaces/.dsh-remote-ignore` 加 `!` 之外的条目即可调整（gitignore 语法）。

**侧边栏远程文件保存失败（409）** —— 远端文件在你打开后已被改动，重新读取后再编辑（mtime 乐观锁保护）。

**密码怎么加密保存** —— 机器表单勾选「加密保存密码」：macOS 用系统钥匙串（security），Windows 用 DPAPI，Linux 需要 secret-tool（libsecret）；后端不可用时自动回退明文。

**升级后插件整个不见了** —— 多半是 DSH 兼容性判定把 bundle 丢弃了（见上文「DSH 版本兼容性」）。升到 **0.8.29+** 即可同时兼容 `0.1.x` / `0.2.x`。

## 安全提醒

把机器凭据交给插件，等于允许 Agent 以你的用户身份在主机上执行 **shell 命令**。只添加你可信的机器。密码保存在本机文件里（或启用后的系统钥匙串），请当作敏感数据处理（可收紧文件 ACL）。开启 `auditLog` 时每条执行的命令都会记入审计日志——可在设置页查看。

## License

MIT

## 参与贡献

欢迎贡献，请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。使用问题、环境配置、「支持 XX 吗」这类讨论请走 [讨论区](https://github.com/flymysql/dsh-remote/discussions)；可复现的缺陷请提 [Issue](https://github.com/flymysql/dsh-remote/issues)。

感谢以下已合并 PR 的贡献者：

[@dahaipeng](https://github.com/dahaipeng) (#31) ·
[@YiHui-Liu](https://github.com/YiHui-Liu) (#28) ·
[@nekomona](https://github.com/nekomona) (#24) ·
[@zhz1667](https://github.com/zhz1667) (#43) ·
[FoolishWiser](https://github.com/FoolishWiser) (#17) ·
[@jace1cch](https://github.com/jace1cch) (#16) ·
[@Minggle](https://github.com/Minggle) (#10) ·
[4FMTWRV](https://github.com/4FMTWRV) (#6) ·
[glzhangzhi](https://github.com/glzhangzhi)（per-session SSH 连接池修复）

## 变更记录

见 [CHANGELOG.md](./CHANGELOG.md)。

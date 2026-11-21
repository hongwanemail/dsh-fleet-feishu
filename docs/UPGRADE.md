# fleet-feishu 插件安装/升级手册（每台设备通用，当前对应 v1.3.0）

> 适用：任何已装 DSH 桌面端的设备加入舰队，或从旧 Python 桥（bridge.py）升级。
> v1.3 升级额外提示：**会话工作目录自愈**——老设备第一次跑带历史会话的任务可能日志出现"会话目录自愈"一行，属正常（自动学回原目录并持久化，历史不断）；macOS 设备务必确认 lark-cli/dsh 可被入口探测找到（fleet_status 里两行入口均非"未找到"）。
> 前提凭证一律**只记位置不进 git**：AppID/AppSecret、模型 key 留在本机 lark-cli 绑定与 .env 里。

## 0. 前置检查（缺什么补什么）

| 项 | 检查命令（本机终端） | 要求 |
|---|---|---|
| lark-cli 已绑定**本设备自己的**应用 | `lark-cli auth status` | bot ready；未绑定先 `lark-cli config` 绑定自己应用的 AppID/Secret |
| user 身份已授权（回执/名册用） | `lark-cli auth status` | 缺则设备码扫码授权，scope 含 `im:message.send_as_user` |
| 本设备 bot 已加入调度群 | 群里看机器人列表 | 每台设备用**独立自建应用**（一设备一 bot） |
| headless 模型 key | 看本机 .env（如 `<工作目录>\.env`） | 文件里 `KEY=value` 每行一条 |

## 1. 拿代码

```bash
# 记忆库所在设备（Mac/办公机/客户均已 clone）
cd <共享记忆库 目录> && git pull
# 新设备：git clone <codeup 仓库地址> ~/共享记忆库（SSH key 找宏万加部署公钥）
```

## 2. 安装（二选一）

- **对 DSH agent 说**：`用 plugin_manager 安装 bundle，target 是 <共享记忆库>/agents/feishu-fleet/dsh-plugin 的绝对路径`
- **手动**：插件页 → Add plugin → 选该目录

装完插件立即启动桥接，无需重启 DSH。

## 3. 配置（插件设置页，必填就 3 个）

| 字段 | 填什么 | 从哪拿 |
|---|---|---|
| `device_name` | 设备名（群里署名） | 自己起，如 `QingLvServer` |
| `chat_id` | 调度群 ID | `oc_eacf...` 开头；不确定就问任意已装设备 `fleet_roster` |
| `bot_open_id` | **本设备 bot** 在群里的 open_id | `ou_` 开头；问已装设备发 `fleet_roster` 里自己的行（注意 open_id 以"自己应用"视角为准，旧桥 config.json 里那个就对） |
| `headless_env_file` | 本机 .env 路径 | 如 `<工作目录>\.env`；留空自动找 `~/.dsh/fleet-feishu/.env`、`~/feishu-fleet/.env` |

可选：`task_timeout_sec`（默认 300）、`session_id`（固定会话）、`task_max_depth`（默认 3）、`roster_interval_min`（默认 60）。

> **v1.3 起新增注意**：`headless_workspace` 决定任务工作目录与会话分桶。**旧 Python 桥靠 `cd` 进部署目录的，升级时务必显式填同一目录**（如 `<工作目录>`），否则历史会话桶搬家、连续上下文丢失；macOS launchd 下继承 cwd 是 `/`，更要填。判断标准：旧 config.json/启动脚本的工作目录是什么就填什么（REG-01 实测教训：环境变量可能在传递链整体丢失，`cd` 继承是平台侥幸不是语义）。

## 4. 停旧 Python 桥（必做，否则双桥抢消息）

Windows：启动文件夹 `feishu-fleet-bridge.cmd` 改名加 `.off`；计划任务的目标脚本 `start_bridge.cmd` 同样改名（schtasks 无权限时用这招釜底抽薪）；杀掉运行中的 `pythonw.exe bridge.py`。
macOS：`launchctl bootout gui/$UID/com.yanghongwan.feishu-bridge`。

## 5. 验收（群里 4 条，1 分钟）

1. `@本bot /status` → 回状态卡（运行中/路条闸/名册 4 员）
2. `@本bot /roster` → 回群名册
3. `@本bot [任务ID|UP-01|指挥部|派发深度1] 只回复：升级自检OK` → 正常执行
4. `@本bot [任务ID|UP-02|指挥部|派发深度9] 你好` → 被拒：深度超限

全中 = 这台设备进入 v1.1 舰队。

## 6. 坑清单（都已在 v1.1 代码内修复，装老版本/排障时对照）

- **黑窗闪**：run.js 启动器 fork worker 自带新控制台 → v1.1 直驱 `bin\lark-cli.exe`
- **发送必挂 invalid file path**：lark-cli `@文件` 白名单不含宿主 cwd → 正文一律 `--text -` 走 stdin
- **headless 模型没 key**：headless 独立进程读不到桌面端 credentials → dotenv 注入（headless_env_file）
- **路条里的 `|` 被 cmd 吃掉（exit 255）**：直调 node，不经 .cmd
- **GBK/BOM**：所有文件读写显式 utf8
- **HERMES_HOME/OPENCLAW_HOME 残留**：spawn 前清理
- **reply 继承 mentions 自循环**：reply_to/root 顶层闸 + [bot-reply] 前缀双保险

## 7. 已知边界（v1.2 方向）

- 跨机派活后**同步等待**会把 task_timeout 用光——正确姿势：派完即结束本任务，结果由对端落 git/群；v1.2 用 `sessionController.prompt` 把对端回执**异步注回**发起会话。
- bot 身份发的路条消息只有 v1.1+ 设备认；user 身份全兼容（fleet_send 默认走 user）。
- 首次安装体验要更傻瓜：计划做配置向导（AppID/Secret + 群名 → 自动发现 bot_open_id/chat_id/探测 headless 路由）。

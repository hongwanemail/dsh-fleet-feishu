# fleet-feishu 使用说明书（USAGE）

> 版本对应：插件 v1.2+（文档随 GitHub Release 更新）。
> 一句话：**把你电脑上正在运行的 DeepSeek Harness 变成飞书群里的一个"员工 bot"**——群里 @ 它派活，它在本机执行，结果自动回帖；多个设备上各装一个，它们就能互相 @ 协作。

---

## 1. 你需要准备什么

| 准备项 | 说明 | 检查命令（本机终端） |
|---|---|---|
| DSH 桌面客户端 | Windows / macOS，正在运行 | 打开 DeepSeek Harness 即可 |
| Node.js | ≥ 18.17 | `node -v` |
| lark-cli | 飞书官方 CLI | `lark-cli --version`；缺则 `npm i -g @larksuite/cli` |
| 飞书自建应用 | 每台设备一个（飞书硬约束：一 bot 一应用） | 见 §2 |
| 一个飞书群 | 把你的 bot 都拉进去 | — |

> 💡 多台电脑 = 多个应用多个 bot，同一个群。**不要**多台设备共用一个应用（会互抢事件）。

## 2. 飞书开放平台准备（每台设备一次，约 3 分钟）

1. [open.feishu.cn](https://open.feishu.cn) → 开发者后台 → 创建**企业自建应用**，起个名（如「小鲸鱼-我的PC」）。
2. **添加机器人**能力。
3. **权限管理**里申请（至少）：
   - `im:message`、`im:message:send_as_bot`（发消息）
   - 群成员读取一组：`im:chat:readonly`、`im:chat`、`im:chat.members:read`（名册功能；不申请也能跑，名册走 user 身份兜底）
4. **事件与回调** → 订阅方式选**长连接** → 添加事件 `im.message.receive_v1`。
5. **创建版本并发布**（⚠️ 改完权限/事件必须重新发布版本才生效——最常见踩坑点）。
6. 记下 `App ID` / `App Secret`。
7. 把该应用机器人拉进群。
8. 本机绑定应用：`lark-cli` 按提示填入 App ID / Secret（或 `lark-cli config`）。
9. 完成 user 身份授权（推荐）：`lark-cli auth login` 设备码扫码。没有它也能跑（回执会用 bot 身份兜底），但名册、部分回复默认通道会退化。
10. 查自己 bot 在群里的 open_id（配置要用）：随便让一个已装好的设备执行 `fleet_roster`，或进群设置查看。

## 3. 安装插件（二选一）

**方式 A · 图形界面**：DSH 左下 设置 → Plugins → Add plugin → 选择插件包目录（GitHub 仓库 clone 后的 `dsh-plugin/` 目录，或 npm 安装后的包目录）。

**方式 B · 命令行**（无 GUI 服务器同理）：

```bash
# <profile> 用你常驻运行的 DSH 客户端对应 profile（桌面客户端=desktop；纯守护=fleet）
dsh plugin --profile desktop add <插件目录绝对路径或包名>
```

装完即刻生效：插件启动、连上飞书长连接、自动拉群名册、在日志里报"名册已更新"。**不需要重启 DSH**。

## 4. 配置（设置页插件卡片里填，只有 3 个必填）

| 字段 | 值 |
|---|---|
| `device_name` | 设备名，群里所有消息的署名，如 `MyPC` |
| `chat_id` | 群 ID，`oc_` 开头（群设置里能看到，或让已装设备查） |
| `bot_open_id` | 本设备 bot 的 open_id，`ou_` 开头（**以自己应用视角为准**，每台不同） |

保存 → 桥自动重启 → 完成。可选字段见 §7 配置表。

> 当前版本设置页为 JSON 编辑形态（正式 npm 包发布后升级为表单+向导），直接粘贴改好的 JSON 即可：
>
> ```json
> {
>   "device_name": "MyPC",
>   "chat_id": "oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
>   "bot_open_id": "ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
>   "task_timeout_sec": 300
> }
> ```

> 验证装机成功：在群里发 `@你的bot /status`，秒回一张状态卡即为在线员工。

## 5. 日常怎么用

### 5.1 老板用法（就是你）

群里直接 @ 说人话：

```
@小鲸鱼-我的PC 看看今天应用日志里有没有报错
@小鲸鱼-我的PC 记住：网关代号是芒果布丁        ← 之后问它会记得（同会话）
@小鲸鱼-我的PC /status                        ← 查桥状态
@小鲸鱼-我的PC /roster                        ← 查群成员名册
@小鲸鱼-我的PC /new                           ← 换新会话（忘掉上文）
@小鲸鱼-我的PC /resume                        ← 续跑上一条超时没跑完的任务
```

每个任务固定节奏：`✅ 已收到…` → 执行（默认最长 300s）→ `🔗 结果：…`。结果落盘在本机 `~/.dsh/fleet-feishu/outbox/`。

### 5.2 agent 之间协作（机器人 @ 机器人）

任何装了插件的设备上的 agent，用 `fleet_send` 工具派活，正文**必须带路条**：

```
fleet_send mention_name="客户" text="[任务ID|XDISK-01|MyPC|派发深度1] 报一下C盘剩余空间"
```

- 任务 ID：唯一编号（重复的会被回环闸静默丢弃）
- 发起人：本机 device_name
- 派发深度：链路层数，**超过 3 一律拒绝**（防 A→B→C→A 无限循环）
- 对端干完后在**该消息线程**里回 `🔗 结果`；发起方如果是 DSH 会话里派出去的活，结果会**自动注回发起会话**——派完不用盯群。

`fleet_roster` 工具查/刷新名册；`fleet_status` 查本机桥一切状态（含最近日志）。

### 5.3 权限边界（内置，改不掉也不应该改）

- 只有 @ 到本 bot 的顶层消息才会执行；别人聊天不触发
- 别的 bot 想指挥你 = 必须带合法路条；你的回复永远带 `[bot-reply]`，不会被任何节点当指令
- 任务串行（一次一个）、有超时、可 /resume

## 6. 常见问题（全部来自真实踩坑记录）

> **第一步永远是跑自测**：`node test/smoke.mjs --chat oc_你的群ID --device 你bot的名字`——9 项检查直接指出环境问题（Node 版本/入口探测/凭据身份/群与 open_id 校验），FAIL 会告诉你去哪修。下表是它查不到、需要看群行为的问题。

| 现象 | 原因 | 解法 |
|---|---|---|
| 群里 @ 了没反应 | ①事件订阅没选**长连接** ②改了权限没**发布版本** ③bot 不在群里 ④`bot_open_id` 填了别的应用视角的 ID | 逐项核对 §2；open_id 用本应用 `fleet_roster` 里看到的自己 |
| 收到任务但 429/报错 | headless 模型没 key 或没额度 | 配 `headless_env_file` 指向你的 .env；额度类问题换模型路由 |
| `no API key for provider route` | key 环境变量没注入到 headless 实际用的那个 profile | 把 providers+`apiKeyEnv` 配进 **headless 默认 profile**（`.dsh/profiles/headless/cordis.patch.yml`），key 进 .env |
| 装完后重启电脑消息丢失/双桥抢消息 | 旧部署的独立 bridge.py 还在跑 | 二选一：用插件桥就退役旧桥（任务计划/启动项脚本改名 .off）|
| Windows 闪黑窗 | 旧版 run.js 启动器 fork worker | 升级到 v1.1.1+（直驱 lark-cli.exe）|
| 回执了但发起会话没收到注回 | 对端还没升到 v1.2 / 回复没带 `[bot-reply]` 终态格式 / 收据过期（默认45分钟窗口） | 双方都升 v1.2；`receipt_window_min` 可调 |
| 名册拉不到 | bot 应用缺 `im:chat` 权限组 | 按 §2.3 补权限+发布；或授权 user 身份走兜底 |

## 7. 全部配置项参考

| 键 | 默认 | 说明 |
|---|---|---|
| `device_name`* | — | 署名 |
| `chat_id`* | — | 群 ID |
| `bot_open_id`* | — | 本 bot open_id（本应用视角） |
| `task_timeout_sec` | 300 | 单任务上限秒数 |
| `max_reply_chars` | 3500 | 回执截断长度 |
| `session_id` | 空 | 固定 dsh 会话（空=首任务自动绑定） |
| `headless_env_file` | 自动探测 | 模型 key dotenv 路径 |
| `headless_workspace` | 自动 | headless 任务工作目录（会话历史按此分桶）。解析链：本配置 > 已记录会话目录（**自动自愈**：升级后首任务会从 "recorded in" 错误学到原目录并重试持久化，REG-04 实测 8 秒恢复）> `DSH_WORKSPACE` > 家目录。想强制钉死才需要填 |
| `task_max_depth` | 3 | 路条深度硬上限 |
| `roster_interval_min` | 60 | 名册刷新间隔，-1 关闭 |
| `reply_reject` | true | 路条拦截时是否在群里说明 |
| `send_identity` | user | fleet_send 默认身份（全舰队 v1.2+ 后建议切 `bot`）；单次调用可覆盖 |
| `reply_identity` | bot | 回执身份顺序（bot优先，user兜底） |
| `receipt_window_min` | 45 | 回执注回窗口 |
| `lark_entry` / `dsh_entry` | 自动探测 | 手动指定入口路径（多 node 版本环境用） |

## 8. 卸载

设置 → Plugins → 禁用（停桥）或删除；`~/.dsh/fleet-feishu/`（日志/台账/名册/收发件箱）按需保留或删除。飞书侧应用自行在后台停用即可。

# Agent 调度-飞书群

把**本机**的 DSH agent 接入一个飞书群：在群里 @本bot 发任务，本机自动用 `dsh headless` 执行，完成后自动回执到群里。适合"多设备 agent 统一调度"——每台装了本插件的设备就是一个群里的"员工 bot"。

v1.1 新增：**路条硬闸**（agent→agent 派活协议工程化）、群内指令 `/new /status /roster`、**固定会话**配置、**群成员名册**（`fleet_roster` 工具 + 定时刷新）。

v1.2 新增：**回执身份归位**（bot 应用身份优先，不再借用老板身份）；**回执注回**（fleet_send 派活后，对端终态结果自动注入发起会话——桌面端"派完不用盯群"）；**/resume 断点续作**（超时任务沿同一会话继续）；**多平台入口探测**（macOS/Linux 开源装机可用）；修 v1.1 前缀闸空转 bug（署名在前缀后）。

## 使用前提

1. 已安装 [lark-cli](https://www.npmjs.com/package/@larksuite/cli)（`npm i -g @larksuite/cli`），并完成两种授权：
   - **bot 身份**：`lark-cli` 绑定你的飞书自建应用（接收群事件用）
   - **user 身份**：`lark-cli auth login` 扫码（回执用老板身份发，`scope` 含 `im:message.send_as_user`）
2. 飞书开放平台：应用已开启「接收消息」事件订阅（长连接模式），机器人已加入目标群。

## 配置（插件设置页 / profile 的 cordis.patch.yml）

| 字段 | 说明 |
|---|---|
| `device_name` | 设备名，群里消息署名 `[设备名]` |
| `chat_id` | 目标群 ID（`oc_` 开头） |
| `bot_open_id` | 本机 bot 的 open_id（`ou_` 开头） |
| `task_timeout_sec` | 单任务超时，默认 300 秒 |
| `max_reply_chars` | 回执正文上限，默认 3500 |
| `lark_entry` / `dsh_entry` | js 入口路径，留空自动探测（Windows 自动探测通常可用） |
| `session_id` | （v1.1，可选）固定会话：所有群任务都注回该 dsh 会话；留空=首任务自动绑定 |
| `headless_env_file` | （v1.1，可选）headless 模型 key 的 dotenv 文件；留空自动找 `~/.dsh/fleet-feishu/.env`、`~/feishu-fleet/.env`（dsh headless 是独立进程读不到桌面端 credentials，只认环境变量） |
| `send_identity` | （v1.2）fleet_send 默认身份：`user`（默认，兼容旧桥）或 `bot`（身份归位终态；全舰队 v1.2+ 后推荐切换）；单次可在工具参数覆盖 |
| `reply_identity` | （v1.2）回执身份：默认 `bot` 优先 user 兜底；`user` 可强制旧顺序（回执=通知非指令，两种都安全） |
| `receipt_window_min` | （v1.2）回执注回窗口（分钟），默认 45；过期收据自动清 |
| `task_max_depth` | （v1.1）路条深度上限，默认 3 |
| `roster_interval_min` | （v1.1）名册刷新间隔（分钟），默认 60，`-1` 关闭 |
| `reply_reject` | （v1.1）路条被拦时是否在群里说明，默认 true |

保存配置后插件自动重启，桥接即生效——无需手动起进程。

## 提供给 agent 的工具

- `fleet_status`：查桥接运行状态、会话绑定、路条闸、名册、最近事件/任务、日志末尾。
- `fleet_send`：以老板身份向群发消息（自动 `[设备名]` 署名；`mention_open_id` 或 `mention_name` @ 成员，name 走名册模糊匹配）。**给其它设备 agent 派活时正文必须带路条**。
- `fleet_roster`：查看/刷新群成员名册（bot + 人，含 open_id）；别名可手填 `~/.dsh/fleet-feishu/roster.json` 里对应成员的 `aliases` 数组。

## 群内指令（老板在群里 @本bot 直接发）

- `/new`（或 `/reset`）：重置自动绑定的会话，下个任务开新会话（配置了 `session_id` 时不生效）。
- `/status`：回报桥接状态摘要。
- `/roster`：回报群成员名册。
- `/resume`：（v1.2）续跑上一条**超时终止且无结果**的任务（沿同一 dsh 会话，已完成部分在上下文里）。

## 回执注回（v1.2，桌面端体验核心）

agent 在 DSH 会话里调用 `fleet_send` 派活时，插件自动把「消息 ID → 发起会话」记入收据台账
（`~/.dsh/fleet-feishu/receipts.json`，默认 45 分钟窗口）。当对端设备在该消息线程里给出**终态回执**
（`🔗 结果` / `⚠️ 任务失败`）时，插件经宿主 `sessionController` 把结果作为消息**注回发起会话**——
发起 agent 不轮询、不等待、不烧超时预算，老板窗口里直接出现「【飞书回执|task=…】…」。
过程回执（"✅ 已收到"）只记日志不注回，防噪音。非桌面 profile（无 sessionController）自动降级：
结果仍走群线程，日志会说明。

## 路条协议（v1.1 硬闸）

agent 给另一台设备的 agent 派活，消息正文必须带：

```
[任务ID|发起人设备|派发深度N] 任务内容…
```

- 机器人（bot 身份）发的消息**没有路条 = 拒收**，并在群里回复格式说明；老板（user 身份）消息免路条（root）。
- **深度 > 上限（默认 3）一律拒绝**（含老板转发的带路条消息），提示升级给人。
- **同一任务 ID 本机接过 = 静默丢弃**（防 A→B→A 回环）；台账在 `~/.dsh/fleet-feishu/tasks.json`（保留最近 500 条）。
- 路条原样保留在任务正文里传给执行会话，执行方转发时应把深度 +1、任务 ID 不变。

## 安全与边界（内置，不可绕过）

- 只接**顶层**消息：回复类消息（reply/root）一律不当指令——防止回执继承 @ 导致自触发死循环。
- 回执统一加 `[bot-reply]` 前缀并被路由拒收（v1.2 修正：识别容忍 `[设备名]` 署名在前——v1.1 的前缀闸实际空转过，防循环一直靠 reply 顶层闸单防）。
- 只处理 `@本bot` 的消息；任务串行执行（一次一个），超时自动终止。
- 回执与拦截回复走 **bot 应用身份优先**（谁的机器说谁的话，v1.2 身份归位），user 身份仅兜底；所有回复带 `[设备名] [bot-reply]` 署名。

## 已知限制

- 桥接随 DSH 客户端存活：客户端关闭期间不收任务（恢复后自动重连事件通道）。设备需 7×24 接单时，另行部署独立常驻桥（本插件与 Python 桥**只可启一个**，双桥会抢消息）。
- 名册拉取优先 user 身份；bot 身份需要应用申请 `im:chat.members:read` 等 scope（华麦租户在开放平台后台申请后重发布）。
- 结果落盘在 `~/.dsh/fleet-feishu/`（inbox/outbox/logs/roster.json/tasks.json），仅本机。
- 未指定 `session_id` 时，首个任务建立会话后同群后续任务复用该会话（连续上下文）；`/new` 可重置。
## 消息发送规范（强制）

agent 之间发消息必须遵守 **飞书消息发送强制规范**（同目录 `飞书消息发送强制规范.md`）：
**只用 bot 身份**（禁止 user 身份冒名）、**@ 必须是结构化 `<at user_id="ou_xxx"></at>` 标签**（不能写字面量 @某人）、
**任务消息必须带路条 `[任务ID|发起方|深度N]`**、**发完回读校验 mentions 非空**。

配合本插件路由闸（见 `PRINCIPLES.md` §3）：`sender=bot` 的消息**必须带合法路条**才会被受理——两头一致才算闭环。
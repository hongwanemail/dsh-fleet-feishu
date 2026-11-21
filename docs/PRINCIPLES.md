# fleet-feishu 原理说明书（PRINCIPLES）

> 本文回答"为什么这样设计、底层到底发生了什么"。所有结论来自 M0-M2 三台设备（macOS / Windows 桌面 / Windows Server）两个月实战与当日全链路实测，非推测。

---

## 1. 全景

```
飞书群（人 + N 个 bot）
   │ 长连接事件推送（免公网 IP，NAT 后可用）
   ▼
每台设备的 DSH 客户端进程
   └─ fleet-feishu 插件（本进程内）
        ├─ consume 子进程：lark-cli event consume im.message.receive_v1（NDJSON 流）
        ├─ 路由闸：判定"这条消息是不是给我的指令"
        ├─ 任务执行器：spawn `dsh headless --json`（一次性 CLI，独立进程）
        ├─ 回复器：lark-cli im +messages-reply / +messages-send
        ├─ 名册器：lark-cli im +chat-members-list
        └─ 注回器：宿主 sessionController.prompt（进程内直调，无需子进程）
```

为什么是**进程内插件**而不是独立守护：DSH 客户端本身是 7×24 常驻宿主，插件复用它的生命周期（崩溃自愈、升级跟随宿主、零额外部署物）；服务器等无 GUI 场景用 `dsh --profile fleet` 的裸宿主进程，同样常驻。**代价**：宿主退出期间不接单——文档明说，属可接受边界。

## 2. 事件通道：飞书长连接 + lark-cli consume

- 飞书对"自建应用+机器人"的事件推送规则：**群里只有 @ 到该 bot 的消息才推给它**（天然的路由第一层）。长连接模式免公网回调地址，家用/办公 NAT、云服务器均可。
- `lark-cli event consume im.message.receive_v1 --as bot` 输出**扁平 NDJSON**（每条事件一行 JSON，`content` 已渲染成可读文本、`mentions[]` 结构化），逐行解析即可，无需自己拼事件 API。
- **stdin 契约坑**（launchd/常驻环境实测）：unbounded 模式下 stdin 关闭 = 退出信号。插件 spawn 时保持 `stdin:"pipe"` 且从不写闭，语义等价"永久挂着的终端"。
- Windows 形态坑：npm 入口 `run.js` 是"fork worker 后父进程退出"——父进程 exit ≠ 消费终止，真身是 detach 的 `lark-cli.exe` worker。因此：直驱二进制入口（v1.1.1）避免黑窗与父进程语义混淆；进程枚举（v1.3 双平台 `psListWorkers`）兜住历史遗留孤儿 worker，防止**多 worker 重复消费同一事件**（真实故障：同一任务被回两遍）。

## 3. 路由闸：一台机器凭什么执行一条消息

一条群消息被受理，必须同时满足（`routeEvent` 纯函数，全分支单测覆盖）：

| 闸 | 条件 | 为什么 |
|---|---|---|
| 群/类型 | 目标群 + `message_type=text` | 富文本 post 的 content 结构不同，M1 实测误触发风险大于收益 |
| **顶层闸** | 无 `reply_to` / `root_id` | **防循环的数学核心**（见 §4） |
| 前缀闸 | 非 `[bot-reply]` 系（v1.2 起容忍 `[设备名]` 署名在前） | 回执双保险（v1.1 此处有真 bug，§4 末） |
| mention 闸 | mentions 含**本应用视角**的自己 open_id | 一机一应用一视角：`ou_` ID 跨应用不同（实测：同一服务器 bot，自家视角 `ou_a9767…`、别家视角 `ou_e534…`），填错=永不响应 |
| 身份闸 | sender=user 直通；sender=bot **必须带合法路条** | 老板免检；员工持证 |
| 路条闸 | 深度≤上限（默认3）+ 任务 ID 本机未接过 | 见 §5 |
| 自我闸 | bot sender ≠ 本 bot | 防配置成同 ID 时自触发 |

## 4. 防无限循环：一次真实事故的完整因果

**事故**（M1 期）：把回执从 bot 身份改为 user 身份后，群里瞬间刷屏十几条——每个 bot 把自己的回执当成了新指令。

**因果链**（每一环都实测确认）：
1. 飞书的线程回复在事件里是**新消息**，且 `mentions` **继承**被回复消息的 @ 列表；
2. 回执用的又是老板 user 身份 → `sender_type=user` 通过；
3. 继承的 mentions 含本 bot → mention 闸通过；
4. 于是"回执自己"= 一条合法新指令 → 再执行再回执 → ∞。

**解定理**：回执永不入指令，两个独立充分条件——①**顶层闸**（reply 不当指令，主防线）；②**前缀闸**（`[bot-reply]` 拒收，辅防线）。v1.1 的前缀闸实现有 bug（署名 `[设备名]` 拼在 `[bot-reply]` 之前，`startsWith` 判空转），但事故从未复发——因为顶层闸单防已充分。v1.2 修正为 `isBotReply`（容忍前导标签序列），双闸真正齐备，且回归测试锁死该格式（`[设备名] [bot-reply] …` 是协议规定的回执文法）。

## 5. 路条协议：跨机协作的防波堤

```
[任务ID|发起人|派发深度N] 正文…        正则：全/半角竖线均可，正文任意位置
```

- **为什么 bot 消息必须持证**：agent 互相指挥是"协作"，也是"循环放大"的通路。路条把责任绑定给**发起的 agent**（AGENTS.md 软约束），把**拦截**交给工程硬闸——软约束可以忘记，硬闸不会。
- **深度上限 3**：宏万→A→B→C 已是三层委托；再深说明任务在踢皮球，强制 @ 人决策。超限**在路由层拒绝，不进模型**——拒绝成本为零，因此可以无脑硬执行。
- **同任务不回环**：受理即把任务 ID 记入 `tasks.json`（留 500 条），重复 ID 静默丢弃。A→B→A 时第二跳必死。选择"静默"而非"回拒"：拒答消息会进对方线程、对方可能再处理——静默是循环的**吸收态**。
- **user 消息带路条也过闸**：老板转发 agent 编排好的派活语句时，协议同等保护（实测 TEST-A 系列）。
- 路条**保留在正文**传给执行会话：执行 agent 看得到发起人与深度，转发时 +1 是它的协议义务。

## 6. 身份模型：三种"说话方式"的语义

| 身份 | 事件 sender_type | 语义 | 用途 |
|---|---|---|---|
| 老板 user 扫码授权 | `user` | 宏万本人在说话 | 人发消息；兼容期派活通行证 |
| bot 应用身份 | `bot` | 某台设备的员工在说话 | **v1.2 起回执/互派的主身份** |
| 回执标记 | —（`[bot-reply]` 前缀） | 永不是指令 | 通知文法 |

> **app/bot 归一化（REV-01 交叉复核实测，2026-11-14）**：飞书**原始消息 API** 里 bot 消息的 `sender.sender_type` 是 `app`，而 lark-cli **事件流（consume 扁平化输出）**里归一化为 `bot`——路由闸以事件流形态为准，认 `user|bot` 两类即完备。对接其他消费端（直接用开放平台 API 的）时注意这两个词表不同。

**演化史即协议史**：M0 全部借 user 身份（旧桥"非 user 不收"）→ v1.1 路由接受"bot+路条" → XDISK-02 实测 bot→bot 全通 → v1.2 回执改 **bot 优先**（谁的机器说谁的话；借老板身份说话会让群里无法分辨"真老板"，且 user token 过期=桥半瘫）。`send_identity` 配置是过渡开关，全舰队 v1.2+ 后默认切 `bot`，user 身份退役为"只属于人"。

## 7. 执行模型：headless 子进程

- 任务执行 = `node <dsh>/lib/bin.js headless --json [--session-id X] <任务文本>`。选 headless 而非向宿主会话注入：**进程隔离**（任务崩了不崩桥）、**零 profile 侵入**（headless 有自己的模型路由 profile）、stdout NDJSON 契约稳定（`session`/`final`/`error` 事件）。
- **直调 node+js 入口、不经 .cmd**（坑 #2）：任务文本含 `|`（路条必有），cmd.exe 会把竖线当管道拆参数 → exit 255 且无输出。
- **credentials 隔离墙**（坑）：headless 是独立进程，**读不到桌面端 UI 存的密钥**，只认环境变量 → `headless_env_file` dotenv 注入，每任务重读（密钥轮换即生效）。密钥值永不进 git/日志/聊天记录，仓库存"位置"不存"内容"。
- 会话上下文：首任务自动绑定返回的 session_id 与当时工作目录到 `state.json`（**headless 的 --session-id 强制目录一致**——REG-03 实测拒绝"recorded in X not Y"；v1.3 桥从错误文本自学记录目录并重试一次并持久化，REG-04 实测 8 秒自愈）→ 同群续聊；`/new` 重置两者；配置 `session_id` 则钉死。**注意**：headless agent 有全套本地工具，"新会话"重置的是对话注入，不是它的记忆力——它仍可从磁盘/会话库翻出旧上下文（实测 T2：agent 从会话记录里考古出正确答案并自报出处）。语义边界要在说明书里讲清楚，而不是假装不存在。

## 8. 回执注回：打通 IM 与 DSH 会话的墙

**问题**：DSH 桌面 profile 被客户端独占，**外部程序**不能向它的活动会话注入消息（M0 期实测）。**破墙**：插件不是外部程序——它就是宿主进程内的代码，宿主服务 `sessionController.prompt(sessionId, content, requestId)` 本来就是 GUI 输入框背后的同一扇门（`requestId` 幂等，冷会话自动 resume）。

链路：
```
agent 会话里调 fleet_send → 桥取 ctx.agents.currentInitiator().id 作发起会话
   → 发消息成功 → 收据 {messageId → sessionId} 入 receipts.json（45min 窗口）
对端在线程回 [bot-reply]：
   过程回执（✅已收到）→ 记日志不注回（防噪音）
   终态回执（🔗结果/⚠️失败）→ prompt 注回发起会话 → 收据删除
```
效果=**派活即忘、结果自到**：老板/主 agent 不必守群轮询，超时预算也不被"等回执"吃光（这正是旧架构里同步等待 300s 超时事故的根治）。非桌面 profile 无此服务时自动降级：仅群内可见 + 日志说明。交付时机=宿主**回合边界**，双样本实测坐实：RCPT-02 过程回执（旧代码注入样本）与 RCPT-03 终态结果 `【飞书回执|task=RCPT-03】🔗 结果：注回成功` 均在注入后的下一个回合完整送达发起会话上下文，全程无人盯群——这是 DSH 消息管线语义，不是缺陷。

## 9. 可靠性工程

- **回执/发送幂等**：发消息带 `idempotency-key`；重发同 ID 不重复执行（回环闸兜底接收侧）。
- **断线自愈**：consume 退出 → 8s 后先查 worker 存活（父进程退出不算退）→ 真退则 10/30/60s 三级退避重启。
- **超时→断点续作**：任务超时被杀 → `resume.json` 记录（仅无最终答案时）→ 老板 `/resume` 沿**同一会话**续跑（已完成部分在上下文里，天然断点）。
- **串行队列**：所有回复/任务经单链 Promise 队列——lark-cli 并发会互抢凭据缓存，且群回执乱序比慢更糟。
- **正文传输走 stdin**（坑 #7）：lark-cli `@文件` 参数有路径白名单（cwd/账户 temp/~/files）——宿主 cwd 不可控，`@文件` 必挂；`--text -` 走标准输入，同时根治 Windows PowerShell 管道毁中文的老问题（不经 shell 转码）。

## 10. 台账文件一览（`~/.dsh/fleet-feishu/`，全部可删可迁移）

| 文件 | 内容 | 生命周期 |
|---|---|---|
| `logs/bridge.log` | 全事件流水（截尾 2000 行） | 滚动 |
| `inbox/<msg>.json` | 收到过什么任务 | 保留 |
| `outbox/<msg>.done.json` | 执行结果与错误 | 保留 |
| `state.json` | 绑定的 dsh 会话 id + 其记录工作目录（由自愈机制维护） | /new 同清空 |
| `tasks.json` | 已受理路条任务 ID（≤500） | 滚动 |
| `roster.json` | 群名册（含手填 aliases） | 定时刷新，别名保留 |
| `receipts.json` | 待回收据（消息→会话） | 45min 窗口自清 |
| `resume.json` | 超时待续作任务 | /resume 后清 |

## 11. 安全边界

- 一机一应用一密钥：应用泄露只波及一台；密钥只在 lark-cli 本机凭据库（Windows keychain / keyring），插件进程从不落盘密钥。
- 一切执行以设备本地用户权限为限；面向客户生产设备的部署应配只读账号/白名单目录（本项目客户实践：只读运维）。
- 路条与署名提供**审计链**：群里每条指令可见"谁、替谁、第几层"。

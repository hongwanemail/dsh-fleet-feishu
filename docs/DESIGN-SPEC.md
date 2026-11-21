# fleet-feishu 设计说明书（DESIGN-SPEC）

> 对应实现：v1.2.x（bridge.js/index.js），本文是工程视角的完整规格。原理与事故依据见 PRINCIPLES.md，用户视角见 USAGE.md。

## 1. 组件结构

```
dsh-plugin/
├─ package.json      # DSH bundle 声明：dsh.bundle.patch → cordis.patch.yml
├─ cordis.patch.yml  # 仅一行 insert（id/name/config:{}）；真实 config 在各设备 profile 补丁层
├─ index.js          # 插件入口：Config 校验、3 个工具注册、hooks 装配、定时刷新
├─ bridge.js         # 桥核心（纯 node: 依赖）：路由/执行/回复/名册/收据/续作/进程管理
├─ test/route.test.mjs  # 33 项协议纯函数测试（node 直跑，无框架）
├─ test/smoke.mjs       # 装机冒烟自测（用户排障第一步，9 项环境检查）
├─ locale/{zh,en}.json  # 插件页文案（meta.title/description/detail）
├─ icon.svg
└─ docs/  DETAIL · UPGRADE · USAGE · PRINCIPLES · DESIGN-SPEC(本文件) · CHANGELOG · PUBLISHING
          · DESIGN-fleet-mention(@补全浮层) · DESIGN-wizard(装机向导)
```

**依赖策略（ADR-1）**：插件**零 @deepseek-ai/* 运行依赖**，Config schema 手工校验、Tool 定义手工构造等价形状。原因：link/本地目录安装解析不到宿主内置包（实测 ERR_MODULE_NOT_FOUND）；零依赖让任何 profile、任何安装通道（GUI/CLI/将来的 npm）行为一致。代价：宿主 Tool 形状若变需跟进（有测试护栏）。

## 2. 生命周期

```
apply(ctx, config)
 ├─ checkConfig → [不过] 桥休眠+日志，工具仍注册（可诊断） 
 ├─ createBridge(config, log, hooks)          # hooks.injectReceipt 用 ctx.get("sessionController") 惰性取
 ├─ ctx.effect( start/stop )                   # 桥随插件启停；配置变更→重 apply→旧桥自动停
 ├─ ctx.effect( timer.interval 名册刷新 )      # roster_interval_min
 └─ ctx.tools.register × 3                     # fleet_status / fleet_send / fleet_roster
```

## 3. 模块规格（bridge.js）

### 3.1 纯函数层（全部单测覆盖）
| 函数 | 签名 | 规则 |
|---|---|---|
| `parseTaskPass(text)` | → `{taskId,from,depth}\|null` | 正则含全/半角竖线、空白容忍、正文任意位置 |
| `routeEvent(evt,cfg,seen)` | → `{accept,task,pass,cmd}\|{reason}` | 闸序：群→text→顶层→前缀→mention→身份→self→路条(深度/回环)→空检查→指令识别 |
| `isBotReply(text)` / `cleanReceiptBody(text)` | → bool/string | 容忍 `[标签]*` 前导（v1.2 修正点） |
| `isFinalReceipt(text)` | → bool | 终态词表：`🔗 结果` / `⚠️ 任务失败` / `⚠️ 任务完成但无回答` |
| `findReceipt(evt,receipts,now)` | → rec\|null | reply_to∨root_id ∨ 前缀 ∨ 未过期 |
| `shouldTrackReceipt({target,ownerSessionId})` | → bool | v1.3：定向派活（有 @ 目标）且有发起会话才登记收据——群公告不登记 |

### 3.2 指令集（`COMMAND_RE`）
`/new /reset`（固定会话模式拒绝并解释）· `/status`（statusText）· `/roster`（名册卡）· `/resume`（续作，消费 resume.json）。仅 user 且无路条时识别。

### 3.3 回执文法（协议对外承诺）
```
回执行  := [设备名] [bot-reply] 内容
内容    := ✅ 已收到，<设备> 开始处理（最长 Ns）…
        | 🔗 结果：\n<答案≤max_reply_chars>
        | ⚠️ 任务失败：<原因>（可发 /resume 续跑）      ← 超时另带 /resume 提示
        | ⚠️ 任务完成但无回答[：<原因>]
        | ⚠️ 路条拦截说明 | ✅ 已重置会话… | 📇 群名册… | ▶️ 续作…
```

### 3.4 进程层
| 点位 | Windows | macOS/Linux |
|---|---|---|
| node 解释器 | `process.execPath`（Electron-as-node 实测可行） | **v1.3 三级阶梯**：PATH 真 node → 显式候选（/opt/homebrew、/usr/local、volta、nvm current）→ Electron 兜底且 spawn 补 `ELECTRON_RUN_AS_NODE=1`（macOS GUI 进程 PATH 不含 Homebrew，实测常识） |
| lark 入口 | `%APPDATA%\npm\...\bin\lark-cli.exe` 直驱 → `scripts\run.js` 回退 | `~/.npm-global`/`/usr/local`/`/opt/homebrew` 候选 + PATH realpath 扫描 |
| dsh 入口 | `%APPDATA%\npm\...\lib\bin.js` | 同前缀 `@deepseek-ai/dsh/lib/bin.js` + PATH |
| spawn 形态 | `.js` 入口→node 前缀；其余直接 spawn（shebang/二进制） | 同左 |
| 环境消毒 | 清 `HERMES_HOME`/`OPENCLAW_HOME`（残留=consume 秒退风暴，实测） | 同左 |
| worker 枚举 | CIM CommandLine 正则 | `ps -ax -o pid=,command=` 同型正则（v1.3） |
| consume stdin | `pipe` 常开（关闭=退出信号） | 同左 |

### 3.5 数据流（三条主链）
```
收链: consume NDJSON → findReceipt?[注回会话|记日志] → routeEvent?[指令|任务]
      → markDone → runTask: inbox落盘→回执✅→spawn headless→(session绑定)→outbox→回执🔗
发链: fleet_send(args, initiator) → 名册解析mention → +messages-send(stdin,idempotency)
      → 收据登记(messageId→session,45min)
注回链: 对端线程终态回执 → findReceipt → hooks.injectReceipt(sessionId,【飞书回执|task=…】正文,requestId幂等)
      → sessionController.prompt → 发起会话下一回合可见
```

## 4. 配置规格（类型/校验/默认）

必填三：`device_name` 非空≠"未命名设备" · `chat_id` ^oc_[\w-]+$ · `bot_open_id` ^ou_[\w-]+$；
`task_timeout_sec` 正数（默认300）。可选：`max_reply_chars=3500`、`session_id=""`、`headless_env_file=自动`、
`task_max_depth=3`、`roster_interval_min=60(-1关)`、`reply_reject=true`、`send_identity=user`、
`reply_identity=bot`、`receipt_window_min=45`、`lark_entry/dsh_entry`（显式覆盖探测）。
校验时机：apply 时；不过=桥休眠但工具可用（可观测地失败，不硬崩）。

## 5. 测试矩阵与验证状态

| 层 | 内容 | 状态 |
|---|---|---|
| 单测 | route/路条/收据/续作/文法/门槛 33 项断言 | ✅ 全绿（node test/route.test.mjs）|
| 本机 E2E | 收→回执→headless→结果→会话绑定→/new 重置 | ✅ 办公机 实测 |
| 跨机 E2E | user派活受理 / bot+路条互派(XDISK-02) / 回环静默(双机) / 深度拦截 | ✅ 双 Windows 机实测 |
| **协议对称性（REV 系列）** | 真实 bot 流量双向受理（办公机⇄QingLv 各自路条闸放行真消息）· **深度2 实网放行**（REV-02）· bot 身份回执出站首战 · **异构版本混跑**：v1.1.1 的 user 身份回执仍被 v1.2 收据正确捕获（匹配只认 reply_to+前缀） | ✅ 2026-11-14 22:16-22:19 日志+群双证据 |
| 注回 E2E | 过程不注/终态注回/prompt accepted/回合边界交付×4样本(RCPT-02/03,REV-01/02) | ✅ |
| **升级兼容** | 会话目录自愈：错误捕获→学路径→重试→持久化（REG-03 抓缺陷 / REG-04 实测 8 秒恢复旧会话上下文） | ✅ 办公机 自身靶机 |
| macOS | 探测/常驻/Electron-as-node/ps 清理 | ⬜ 周一 FLEET-UP-02 清单 |
| 装机通道 | GUI Add plugin / `dsh plugin --profile add`（link 形态 git pull 即升级） | ✅ 双通道实测 |

## 6. 演进路线

| 版本 | 内容 | 状态 |
|---|---|---|
| v1.0 | 进程内桥移植（三闸/直调/署名） | ✅（发送通道有 @file 白名单隐患）|
| v1.1 | 路条硬闸·群指令·名册·dotenv 注入 | ✅ |
| v1.1.1 | 黑窗修复（直驱 exe） | ✅ |
| v1.2 | 身份归位·回执注回·/resume·多平台探测·前缀闸修正 | ✅ |
| v1.3 | POSIX 进程层补齐（本轮）→ README/LICENSE 开源套件 → @补全浮层（fleet-mention，设计稿已定：`conversation.input.overlay` 槽位+路条自动生成，见 DESIGN-fleet-mention.md）| 🔄 |
| v1.4 | 装机向导（DESIGN-wizard.md）·任务台账对账命令·心跳注册表（lark-base）·npm 发布与改名 | ⬜ |

## 7. 设计决策记录（ADR 摘要）

1. **零宿主依赖**（见 §1）——可移植性压倒开发便利。
2. **子进程 headless 而非宿主内跑任务**——隔离崩溃与 profile；NDJSON 契约稳定；"外部程序不可注入宿主会话"当年是硬墙，插件以进程内身份破墙（`sessionController`），但**执行**仍留在子进程（宿主会话与员工工作区分离的语义也更好）。
3. **回执=线程回复，永不顶层**——顶层消息即指令候选，回执混入顶层=循环燃料；注回机制直接消费线程回复，两全。
4. **回环静默丢弃而非拒绝回复**——拒绝消息会被对端再处理，静默是吸收态；台账留痕可事后审计。
5. **一设备一应用**——飞书推送语义决定（bot 只收 @ 自己的事件）+ 爆炸半径隔离。
6. **不用飞书官方 Node SDK 直连 WS**——lark-cli 已封装长连接重连/凭据/幂等且跨平台单二进制；引 SDK=引依赖树+凭据自管。留作 v1.4 评估项（daemon 化时重新权衡）。
7. **路条放正文不放开元数据**——IM 消息是用户可见的：协议必须"长在人能读的地方"，审计零成本。

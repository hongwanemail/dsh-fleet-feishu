# fleet-mention 设计稿：DSH 输入框 @ 补全浮层（v1.3 实现目标）

> 状态：设计定稿待实现。宿主 API 证据均来自 2026-11-14 对本机 live 环境的实查（Slots.listSubTree / Services listService）。

## 需求（宏万原话）

"在 dsh 的输入框中输入 @ 符号后，后面可以显示 飞书群名称 + 机器人选择；发送消息后 dsh 会自动发送到群里的机器人，并且可以实时得到机器人的回复。"

后半句"实时得到回复"已由 **v1.2 回执注回**（sessionController）实现——本设计只做前半句：@ 补全浮层。

## 架构：一个 bundle 两个半

```
@local/fleet-feishu（现有 Host 半，不动核心）
        + 新增 Client 半（同包 client.js，dsh.client 声明）
```

### Client 半落点（live 实查确认存在）

| 用途 | 槽位 | 类型/scope |
|---|---|---|
| @ 弹出浮层 | `conversation.input.overlay` | list / session（"Floating entries rendered inside the resident composer card"）✅ 首选 |
| 备选：卡片下方常驻条 | `conversation.composer.dock` | list / session |
| 备选：卡片上方全宽 | `conversation.input.dock` | list / session |

注意：docked composer 内 fixed 元素需 portal 到 document body（槽位说明原话）。

### 数据流

```
输入框键入 "@" → client.js 读取输入（参照 dsh-client-ui-input-trigger 的 useInput/inputActions 机制）
  → fetch /api/fleet/roster（同源，Host 半注册 webServer 路由，读 roster.json + 群名）
  → 浮层列出：群名 头部 + 成员行（🤖 bot / 👤 人，含别名）
  → ↑↓ 选择，Enter 确认 → 把 "@成员名 " 插入输入框（纯文本可编辑）
发送时拦截（第二版）：正文以 @成员名 开头 → inputActions 改为调用 fleet 发送 API 而非本地会话
  → POST /api/fleet/dispatch {text, mentionName}
  → Host 半 bridge.send(ownerSessionId=当前会话) → 自动带路条 + 回执注回（v1.2 已具备！）
```

**关键红利**：v1.2 的回执注回已经把"发送→等待→结果回会话"的通路建好了，
浮层只要把用户的输入接到 `fleet_send` 等价路径上，"实时得到机器人的回复"零新成本。

### Host 半需要的小改动（实现时做）

1. `webServer.register({kind:"exact", path:"/api/fleet/roster", handler})`（先例：dsh-balance、dsh-client-hmr）
2. `webServer.register` POST `/api/fleet/dispatch`（body: {text, mentionName|mentionOpenId, chatId?}），
   handler 里 `sessionController.resolveAgent(sessionId).agent` 作为 initiator 上下文调用 bridge.send
   ——或者更简单：dispatch 直接返回指令文本，让 UI 通过 commands.execute 提交给 agent 一条
   "用 fleet_send 发…"的消息。第一版取简单方案：UI 把正文+路条组装好交还给 agent 发送。
3. 群名：roster.json 增加 chat_name（`im chats.get` 或 +chat-list 匹配，bot 身份有 im:chat scope 即可）。

### 路条自动组装（浮层版协议）

用户选择"@小鲸鱼-客户服务器 报一下磁盘" → dispatch 前自动包：
`[任务ID|M-<yyyymmddHHmm>-<seq>|<本机 device_name>|派发深度1] 报一下磁盘`
任务 ID 由 Host 半生成（时间+内存计数器，持久化 seq 到 runtimeDir/dispatch-seq.json），
用户不感知路条、协议却完整——开源用户体验的关键设计。

## 交互细节（v1.3 第一版范围）

- 触发：输入框行首/空格后打 `@`，浮层弹出（0.2s 防抖）；继续输入过滤（拼音首字母不必做，别名手填即可）
- 列表：群名做 header；行=图标+名称+type 标签；本机 bot 也显示（=发普通群消息不派活）
- 键盘：↑↓ 选择 / Enter 或 Tab 确认 / Esc 关闭；鼠标同理
- 空名册：显示"名册未同步——按 F5 调 fleet_roster refresh"提示（可先走 overlay 内按钮 POST /api/fleet/roster?refresh=1）
- 主题：继承宿主 token（Theme.listTokens），不硬编码颜色

## 验收标准

1. 办公机 GUI 输入框打 @ → 浮层显示"Agent 调度群 · 小鲸鱼-客户服务器 …"
2. 选中后发送"报一下 C 盘" → 群里出现带自动生成路条的派活消息
3. 客户完成 → 🔗 结果出现在**当前会话**（v1.2 通路）
4. Esc/点击外部 → 浮层关闭无残留（ctx.effect 清理验证）

## 风险与开放问题

- 输入读取 API（useInput/inputActions）是宿主内部包导出：client.js 里以
  `window.__ModuleLoader__` 模块表取（React 先例已证），非公开稳定 API——开源打包时
  若宿主升级需回归测试（记录版本 0.2.2-rc.3 实测可行）
- 拦截"发送"改道的方案 II（dispatch 直发）涉及 commands.execute 权限，第一版先不拦截，
  只做"文本插入"（用户按回车 = agent 自己调 fleet_send，AGENTS.md 协作规矩已有引导词）

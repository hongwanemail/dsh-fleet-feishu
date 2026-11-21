# fleet-feishu —— 把你的 DSH 变成飞书群里的员工 🐳

**多设备 AI agent 协作调度插件**：每台电脑装一个，群里的机器人就是那台电脑的 DeepSeek Harness。
@ 它派活，它在本机执行并回帖；机器人之间带"路条"互相派活协作；结果自动注回你的会话——**派完不用盯群**。

> ⭐ 适用于：家里有 Windows、办公室有 Mac、手里还有服务器的人（设备多到管不过来的人）。

```
老板（手机/桌面）──飞书群──▶ 🤖 小鲸鱼-笔记本 ──路条──▶ 🤖 小鲸鱼-办公机 ──▶ 本机 dsh 执行
                                       ▲                        │
                                       └──── 🔗 结果自动注回 ◀──┘
```

## 特性

- 📱 **群里 @ 就干活**：任务经 `dsh headless` 在本机执行，结果回帖，上下文延续（`/new` 重开会话）
- 🤝 **机器人互相派活**：路条协议 `[任务ID|发起人|派发深度N]`，深度硬闸 + 同任务回环吸收
- 🔔 **回执注回**：派出去的活，完成结果自动出现在你的 DSH 会话里，不用守群轮询
- 👥 **群名册**：成员/别名模糊匹配，`fleet_roster` 随手可查
- 🛡 **安全边界**：只有 @ 到本 bot 的顶层指令才执行；真人免检、agent 必须持证；密钥只存本机凭据库
- 🖥 **跨平台**：Windows / macOS / Linux；桌面客户端与 `dsh --profile fleet` 无头守护两种形态

## 安装

### 方式 A：从 GitHub 安装（推荐，无需构建）

```bash
dsh plugin --profile desktop add github:hongwanemail/dsh-fleet-feishu
```

本包是**纯 JavaScript**（无编译步骤、无 `build` 脚本），因此 pnpm **不会要求你授权 `allowBuilds`**——
不需要在 `pnpm-workspace.yaml` 里开任何构建开关，安装即可用。

> 若未来发布 TypeScript 版本，则需要作者提供 `prepare` 脚本、你在 profile 的 `pnpm-workspace.yaml` 里
> 写 `allowBuilds: { dsh-fleet-feishu: true }` 授权构建。

### 方式 B：tarball（离线/内网）

```bash
npm pack            # 或 pnpm pack → dsh-fleet-feishu-1.4.0.tgz
dsh plugin --profile desktop add ./dsh-fleet-feishu-1.4.0.tgz
```

### 方式 C：源码目录

```bash
dsh plugin --profile desktop add /path/to/dsh-fleet-feishu
```

## 配置

安装后在 profile 的 `cordis.patch.yml`（或桌面客户端 设置 → Plugins → 该插件 → 配置）里填三项：

```yaml
- insert:
    - id: fleet-feishu
      name: 'dsh-fleet-feishu'
      config:
        device_name: 小鲸鱼-办公机       # 群里署名
        chat_id: oc_xxxxxxxxxxxx          # 群 ID
        bot_open_id: ou_xxxxxxxxxxxx      # 本 bot 在【本应用视角】下的 open_id
```

其余项（超时、深度上限、回执窗口、名册刷新间隔、lark/dsh 入口路径等）都有默认值，
见 [docs/USAGE.md](docs/USAGE.md) 的配置表。

## 30 秒上手

1. 前置：DSH 桌面客户端 + [lark-cli](https://www.npmjs.com/package/@larksuite/cli) + 一个飞书自建应用（机器人）拉进群
2. 安装（见上）→ 填三项配置
3. 群里发 `@你的bot /status` —— 有状态卡回执即入职成功

装机不顺利？**先跑一条自测**（9 项环境检查，指出错在哪、去哪修）：

```bash
node test/smoke.mjs --chat oc_你的群ID --device 你bot的名字
```

## 工具

| 工具 | 作用 |
|---|---|
| `fleet_send` | 向调度群发消息，可 @ 某个 bot（`mention_open_id` / `mention_name`），自动带本机署名与路条 |
| `fleet_status` | 本机桥接状态：是否在监听、会话绑定、路条闸、名册、最近任务与日志 |
| `fleet_roster` | 群成员名册（`action=refresh` 现拉） |

群内指令（仅真人身份可用）：`/status` `/roster` `/new`（重开会话）`/resume`（续跑上次超时任务）。

## 文档

| 文档 | 回答什么问题 |
|---|---|
| [docs/USAGE.md](docs/USAGE.md) | 怎么装、怎么用、出问题怎么办（FAQ 全部来自实测踩坑） |
| [docs/PRINCIPLES.md](docs/PRINCIPLES.md) | 为什么这样设计：防循环数学、身份模型、进程模型、注回机制 |
| [docs/DESIGN-SPEC.md](docs/DESIGN-SPEC.md) | 工程规格：模块/协议文法/配置项/测试矩阵/设计决策记录 |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 版本史：每个坑如何变成协议的一部分 |
| [docs/UPGRADE.md](docs/UPGRADE.md) | 从旧 python 桥迁移 + 验收四连 |
| [docs/PUBLISHING.md](docs/PUBLISHING.md) | 发布检查清单与待决事项 |

## 开发与测试

```bash
pnpm install
node test/route.test.mjs     # 33 项协议纯函数测试，无需任何依赖（clone 即可运行）
node test/smoke.mjs --chat oc_xxx --device bot名   # 9 项环境自检
```

## Model Experience

### fleet_send

#### What the model sees

三个工具的描述与参数 schema 会进入系统提示。`fleet_send` 的描述里写明了身份语义
（默认 bot、需要真人身份时显式 `identity: "user"`）、路条要求（给别的设备 agent 派活必须带
`[任务ID|发起人|派发深度N]`）与 at 标签的正确写法（用 `mention_open_id` 参数，**不要手写 `<at>` 标签**）。
`fleet_status` 的描述说明它返回的是桥接状态快照，`fleet_roster` 说明名册与别名匹配。

#### Token effect

三个工具描述合计约 600 字符（约 400 token），常驻系统提示。参数 schema 为 spec 风格
（`{ 字段: { type, required?, description? } }`），由 `@deepseek-ai/dsh-tools` 在注册时编译成 JSON Schema。

#### KV Cache effect

工具定义在插件加载时注册一次，之后不变 → 不产生缓存抖动。`fleet_status`/`fleet_roster` 的
参数为空对象，保持稳定；只有 `fleet_send` 的 schema 带字段。

### fleet_status

#### What the model sees

返回一段纯文本状态卡：是否在监听群、会话绑定、路条深度与已接任务数、待收回执、续作台账、
名册摘要、最近事件/任务时间，以及桥接日志末 12 行。日志是排查的唯一入口，因此刻意包含在输出里。

#### Token effect

状态卡约 400–800 字符；日志段是最长部分（12 行）。无参数，不产生额外调用开销。

#### KV Cache effect

纯读取，无副作用。

### fleet_roster

#### What the model sees

群成员列表（名称、类型、open_id、app_id、别名），以及服务端截断告警（若有）。
`action=refresh` 会立即调飞书接口重拉。

#### Token effect

5 名成员约 200 字符；成员多时线性增长。

#### KV Cache effect

默认读本地缓存（roster.json，每 `roster_interval_min` 分钟自动刷新一次），`refresh` 才走网络。

## Known Limitations and Deferred Work

- **消息类型只支持 `text`**：飞书 `post` 富文本消息不触发路由（实测误触发风险大于收益，故不放开）。
- **回执注回依赖 `sessionController` 服务**：纯 base profile（无 web/桌面端）没有该服务，
  此时回执只在群里可见，注回会记录"注回失败"但不影响群内消息。
- **`ou_` open_id 跨应用视角不同**：同一 bot 在不同应用视角下 id 不同，`bot_open_id` 必须填
  **本应用视角**的那个，否则永不响应。
- **`dsh headless` 的会话目录一致性**：`--session-id` 强制"记录目录 = 工作目录"，
  插件实现了三级解析链与一次自愈重试，但老会话（建在旧路由时代的）仍可能 compaction 卡死。
- **单宿主约束**：同一台机器上**只应运行一个 fleet 宿主**（桌面客户端或 `dsh --profile fleet` 二选一）。
  两个实例会互清对方的 consume worker，造成重启风暴与重复消费。
- **待办**：在线感知 Presence 协议（MQTT 风格）、输入框 @ 补全浮层、3 分钟装机向导
  （见 [docs/OPTIMIZATION.md](docs/OPTIMIZATION.md) 与 `docs/DESIGN-*.md`）。

## 安全

安全边界与漏洞报告：见 [SECURITY.md](SECURITY.md)。功能 bug 请用 issue 模板（记得脱敏）。

## License

MIT —— 由 宏万 与他的 AI 舰队 🐳 开发

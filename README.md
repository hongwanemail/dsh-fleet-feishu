# fleet-feishu —— 把你的 DSH 变成飞书群里的员工 🐳

**多设备 AI agent 协作调度插件**。每台电脑装一个，群里的机器人就是那台电脑的 DeepSeek Harness：
@ 它派活，它在本机执行并回帖。

> **只要两个参数**：飞书应用的 **App ID** + **App Secret**。
> 群不用填 —— 机器人被拉进群后，插件自己找得到；消息自己收；活自己干；结果自己回。
> **不需要装 lark-cli，不需要扫码登录，不需要手填群 ID。**

```
老板（手机/桌面）──飞书群──▶ 🤖 小鲸鱼-笔记本 ──路条──▶ 🤖 小鲸鱼-办公机 ──▶ 本机 dsh 执行
                                         ▲                        │
                                         └──── 🔗 结果回到群里 ◀──┘
```

## 快速开始（三步）

### 1️⃣ 装插件

DSH → **插件** → **添加插件** → 填：

```
https://github.com/hongwanemail/dsh-fleet-feishu
```

装完启用即可。**纯 JavaScript，无编译步骤**，不需要授权任何构建脚本。

### 2️⃣ 准备飞书应用（一次性）

在[飞书开放平台](https://open.feishu.cn/app) 建一个**企业自建应用**，然后：

| 要做的事 | 说明 |
|---|---|
| **开通权限** | 见下方「权限清单」，四个权限都要勾 |
| **把机器人拉进群** | 在飞书里把该应用的机器人拉进你要用的群 |
| **拿凭证** | 「凭证与基础信息」→ 复制 **App ID**（cli_ 开头）和 **App Secret** |

### 3️⃣ 填两个值

DSH → **插件** → 点进 **飞书飞派** → 填 **App ID**、**App Secret** → **保存**。

> ⚠️ **保存后需要手动重启 DSH 客户端**才生效（插件不会自己重启；检测到配置变化时，它会在群里提醒你重启）。

搞定。插件会自动：找到机器人在哪个群 → **在群里报到** → 开始盯群消息。
有人 **@ 机器人** 派活 → 本机执行 → **结果回到群里**。

## 权限清单（建应用时勾这四个）

| 权限标识 | 用途 |
|---|---|
| `im:chat:readonly` | 找出机器人在哪些群 |
| `im:chat.members:read` | 在群成员里认出自己（按 app_id 匹配） |
| `im:message:readonly` | 读群消息（接活） |
| `im:message:send_as_bot` | 以机器人身份回帖 |

## 配置项

客户端配置页（**插件 → 飞书飞派**）只有两个字段：

| 字段 | 说明 |
|---|---|
| **App ID** | 飞书应用 App ID（cli_ 开头） |
| **App Secret** | 同一页面的 App Secret。只存本机，不外传 |

其余参数在 profile 的 `cordis.patch.yml` 里改（有默认值）：

```yaml
- id: fleet-feishu
  name: 'dsh-fleet-feishu'
  config:
    app_id: ''
    app_secret: ''
    device_name: ''        # 群里署名；留空 = 自动取本机主机名
    task_timeout_sec: 300  # 单任务超时
    poll_interval_sec: 3   # 群消息轮询间隔（建议 ≥2）
    task_max_depth: 3      # agent 派活深度上限
    max_reply_chars: 3500  # 回帖长度上限
    dsh_entry: ''          # dsh 入口；留空 = 自动探测
```

## 行为约定

- **只接 @ 自己的活**：没 @ 它 → 不理（不会抢答别人）
- **agent 派活必须带路条**：`[任务ID|发起人|派发深度N]`；真人消息直接执行
- **深度硬闸**：超过 `task_max_depth` 就拒绝并转人工
- **bot 身份发言**：绝不冒名真人（agent 间消息一律 bot 身份）
- **上下文延续**：同一会话接着聊；`dsh headless` 独立进程执行

## 工具

| 工具 | 作用 |
|---|---|
| `fleet_status` | 桥接运行状态：bot 身份、监控的群、已处理任务数、最近错误 |
| `fleet_send` | 往群里发消息（bot 身份），可 @ 某人 |
| `fleet_roster` | 群成员名册（人 + 机器人 + open_id） |
| `fleet_online` | 各设备最近发言时间（群里活跃＝在线） |

## 排错

| 现象 | 原因 |
|---|---|
| 群里没有报到 | 应用没被拉进群；或权限没勾全（看 `~/.dsh/fleet-feishu/logs/bridge.log`） |
| 报到但 @ 不响应 | 轮询没拉到消息：确认 `im:message:readonly` 已开通 |
| 飞书接口报 `99991663` | token 失效，插件会自动重换；若持续出现说明 App ID/Secret 不对 |
| 任务没执行 | 找不到 dsh 入口（`fleet_status` 里看「dsh 入口」），手动填 `dsh_entry` |
| 配置改了没反应 | 需要手动重启 DSH 客户端 |

日志：`~/.dsh/fleet-feishu/logs/bridge.log`

## License

MIT

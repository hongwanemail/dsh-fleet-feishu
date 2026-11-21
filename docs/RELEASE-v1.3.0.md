# v1.3.0 发布说明（Release Notes 成品文案，建仓后直接粘贴）

## GitHub Release（EN/CN 双语正文）

**fleet-feishu v1.3.0 — turn every DSH you run into a coworker in one Feishu group**

Install this plugin on each machine, and its DeepSeek Harness becomes a bot in your group chat: @ it to delegate work, results come back to the thread — and to *your session*. Bots delegate to bots via signed task passes with hard loop-guards. Built for people with more computers than attention.

**Highlights**
- 🤖 @-mention → local `dsh headless` execution → threaded receipt; per-group continuous context (`/new` to reset)
- 🧾 Task-pass protocol `[taskId|origin|depthN]`: bot-to-bot dispatch, depth cap (default ≤3) enforced at the router, repeated task-ids silently absorbed — anti-loop is engineering, not prompt prayer
- 🔔 Receipt injection: final results from remote devices are injected back into the originating DSH session (no group-watching, no timeout budget burned waiting)
- 👥 Live group roster with aliases, fuzzy @ resolution (`fleet_roster` / `fleet_send` / `fleet_status` tools)
- 🪟🍎 Windows & macOS; GUI install (Add plugin) or `dsh plugin --profile <p> add`; headless `--profile fleet` for servers
- 🧯 Self-healing session-workdir migration, orphan consumer cleanup, reconnect backoff, `/resume` for timed-out tasks
- 📚 Full docs: USAGE / PRINCIPLES / DESIGN-SPEC / CHANGELOG / SECURITY + one-command env smoke test

**Quick start**: install → set `device_name` / `chat_id` / `bot_open_id` → `@yourbot /status` in the group.
Troubleshoot first with: `node test/smoke.mjs --chat oc_xxx --device YourBotName`

**Requirements**: DSH desktop client, Node ≥ 18.17, lark-cli bound to your own Feishu custom app (bot) — see docs/USAGE.md §2.
**License**: MIT.

---

## B站视频简介区文案（中文）

我把每台电脑上的 DeepSeek Harness 变成了飞书群里的员工机器人——
@ 它就派活，它干完自动回帖；机器人之间还能互相 @，带工单编号、限深度、防死循环，结果自动弹回我的对话窗口，派完根本不用盯群。

这个插件免费开源，Windows / macOS 都能装。仓库和三步安装法在置顶评论。
三台真机实测：笔记本 指挥部 + 家里 PC + 云服务器客户服务器（只读运维）。

📦 GitHub：（地址定了填这里）
📖 文档：README → USAGE（3 分钟装机）→ PRINCIPLES（防失控的协议设计）

## 置顶评论（一句话版）

装好 DSH 和 lark-cli 后：建飞书自建应用（开 im 消息权限+长连接事件）→ 机器人拉进群 → DSH 设置里 Add plugin 选仓库目录 → 填 3 个配置 → 群里发 `@你的bot /status`。装不上先跑 `node test/smoke.mjs --chat 群ID --device bot名`，它会告诉你哪一步错了。

## 发布公告模板（可选发 DSH/飞书社区时）

> fleet-feishu：让 DSH 组成你的飞书群舰队。一台电脑 = 一个员工；一个群 = 你的指挥部；一份路条协议 = 员工协作不失控。开源，MIT，Win/Mac。

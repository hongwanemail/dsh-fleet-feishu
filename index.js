// fleet-feishu 插件入口：Agent 调度-飞书群（进程内桥接，v1.1）
// v1.1：路条硬闸（agent→agent 必须带 [任务ID|发起人|派发深度N]，深度超限拒收、同任务回环静默丢）、
//       群内指令 /new /reset /status /roster、配置固定 session_id、群成员名册（fleet_roster + 定时刷新）。
// 设计约束（2026-11-21 修正）：本插件**按官方规范实现**——
//   · 工具走 dsh-tools 的 defineTool（参数 spec→JSON Schema 自动转换 + execute 前置校验）
//   · Config 导出 Schemastery schema（Cordis 加载时校验并填充默认值）
//   · 与宿主共享实例的 dsh 包在 package.json 的 peerDependencies + devDependencies 同时声明
// 之前"零内置包依赖"的变通写法已废弃（实测：插件目录解析不到 dsh-tools/schemastery，
// 根因是未声明 peer；按官方方式声明后 pnpm 会把宿主实例链接过来）。
// 生命周期：apply 时按配置启动桥接；配置变更触发插件重启（apply 重跑），cleanup 自动停旧桥。
import { defineTool } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";
import { createBridge, makeLogger, runtimeDir, parseTaskPass, cfgValue } from "./bridge.js";

export const name = "fleet-feishu";
export const inject = ["tools", "timer", "agents"];

// 工具包装（等价 dsh-tools defineTool 的最小产出形状；参数直接用 JSON Schema，校验在 execute 内做）
// 统一文本工具封装（走 dsh-tools 的 defineTool：参数 spec→JSON Schema、execute 前置校验）
function textTool(name, description, parameters, execute, isConcurrencySafe) {
  return defineTool({
    name,
    description,
    parameters,                                  // spec 风格：{ 字段: { type, required?, description? } }
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value ?? "") }],
    },
    async execute(args) {
      return String(await execute(args));
    },
    ...(isConcurrencySafe ? { isConcurrencySafe: () => true } : {}),
  });
}

// Config schema（Schemastery / Standard Schema）——Cordis 加载时校验并填默认值。
// 关键三项（device_name / chat_id / bot_open_id）缺失时不阻断插件加载，只让桥保持休眠，
// 原因见 checkConfig 的注释（这是本插件的既定行为：工具始终可见，便于排查）。
// 注意：所有字段都用 .volatile() 声明——DSH 设置页「插件 → 插件配置」的表单
// 只展示 volatile 字段（@deepseek-ai/dsh-settings），不加 volatile 就看不到 → 用户不会整。
// 改动由 @deepseek-ai/dsh-config-editor 写回 profile patch 并立即生效。
export const Config = Schema.object({
  device_name: Schema.string().default("agent")
    .description("★ 必填：你在群里的署名，例如「小鲸鱼-办公室PC」。群里发消息时会带上它，别人才知道是谁在干活。")
    .volatile(),
  chat_id: Schema.string().default("")
    .description("★ 必填：飞书群 ID（oc_ 开头）。打开群 → 群设置 → 群 ID 即可复制。机器人只在这个群里派活。")
    .volatile(),
  bot_open_id: Schema.string().default("")
    .description("机器人 open_id（ou_ 开头）——【可留空】：留空时插件会拉群名册、按自己的飞书应用自动匹配；若自动匹配不到（群里没这个机器人或应用不一致），可从群成员列表里找该机器人的 open_id 填这里。")
    .volatile(),
  task_timeout_sec: Schema.number().default(300)
    .description("单个任务的执行超时（秒）。")
    .volatile(),
  max_reply_chars: Schema.number().default(3500)
    .description("单条回帖的最大字符数，超出截断。")
    .volatile(),
  task_max_depth: Schema.number().default(3)
    .description("路条派活的最大转手深度（安全闸），超过就拒收。")
    .volatile(),
  receipt_window_min: Schema.number().default(45)
    .description("回执注回的等待窗口（分钟）。")
    .volatile(),
  roster_interval_min: Schema.number().default(60)
    .description("群名册刷新间隔（分钟）；-1 关闭。")
    .volatile(),
  send_identity: Schema.string().default("bot")
    .description("发消息用的身份：bot（机器人，推荐）或 user（真人身份，一般不用）。")
    .volatile(),
  reply_identity: Schema.string().default("bot")
    .description("回执用的身份：bot（推荐）或 user。")
    .volatile(),
  reply_reject: Schema.boolean().default(true)
    .description("收到不合规的 agent 消息时是否回一条拒绝提示。")
    .volatile(),
  session_id: Schema.string().default("")
    .description("固定 dsh 会话 id；留空 = 每个任务自动开会话。")
    .volatile(),
  headless_profile: Schema.string().default("")
    .description("执行任务用的 DSH profile 名；留空 = 默认 headless。")
    .volatile(),
  headless_env_file: Schema.string().default("")
    .description("存放模型 key 的 .env 文件路径（留空自动找）。")
    .volatile(),
  headless_workspace: Schema.string().default("")
    .description("执行任务的工作目录（会话按它分桶，改了会导致旧会话找不到）。")
    .volatile(),
  lark_entry: Schema.string().default("")
    .description("lark-cli 可执行文件路径；留空 = 自动探测。")
    .volatile(),
  dsh_entry: Schema.string().default("")
    .description("dsh 可执行文件路径；留空 = 自动探测。")
    .volatile(),
  // 「像人一样协作」：问-答 + 留言板
  hello_timeout_sec: Schema.number().default(12)
    .description("问对方「在吗」后等多久算没回应（秒），超时转为留言。")
    .volatile(),
  peer_ttl_sec: Schema.number().default(300)
    .description("多久没应答就认为对方已离线（秒）。")
    .volatile(),
  ask_before_dispatch: Schema.boolean().default(true)
    .description("派活前先问一句「在吗」：答了就派，没答就留言。关掉则直接派。")
    .volatile(),
});

function checkConfig(config) {
  // 官方规定：volatile 字段的运行时值是 Volatile<T> 引用，要 .get() 读。
  // DSH 0.2.2-rc.5 起生效；直接拿 config.chat_id 做正则匹配会拿到对象 → 误报「配置未就绪」。
  const problems = [];
  const deviceName = cfgValue(config.device_name);
  const chatId = cfgValue(config.chat_id);
  const botOpenId = cfgValue(config.bot_open_id);
  const timeout = cfgValue(config.task_timeout_sec);
  if (!deviceName || deviceName === "未命名设备") problems.push("device_name 未设置（群里署名用）");
  if (!/^oc_[\w-]+$/.test(chatId || "")) problems.push("chat_id 未设置或不是 oc_ 开头的群 ID");
  // bot_open_id 留空可运行：桥会拉名册后按自己的 app_id 自动匹配（实测可靠）
  if (botOpenId && !/^ou_[\w-]+$/.test(botOpenId)) problems.push("bot_open_id 格式不对（ou_ 开头）");
  if (typeof timeout !== "number" || timeout <= 0) problems.push("task_timeout_sec 必须为正数");
  return problems;
}

export function apply(ctx, config) {
  // Config 不声明 schema（见头部说明）→ 手工校验；缺配置不打断插件激活，只让桥保持休眠并在工具里可见
  const problems = checkConfig(config);
  if (problems.length > 0) console.log("[fleet-feishu] 配置未就绪（桥保持休眠）：" + problems.join("；"));

  // v1.2 回执注回：sessionController 在 dsh-base 里是可选服务（web 桌面端有、纯 base profile 无）
  // 用 ctx.get 惰性取，缺失时 injectReceipt 抛错 → 桥日志记录"注回失败"，群内回执不受影响
  const bridge = createBridge(config, makeLogger(runtimeDir()), {
    injectReceipt: async ({ sessionId, text, requestId }) => {
      const sc = ctx.get("sessionController");
      if (!sc?.prompt) throw new Error("当前 profile 无 sessionController 服务（回执仅群内可见）");
      const res = await sc.prompt({ sessionId, content: [{ type: "text", text }], requestId }, new AbortController().signal);
      if (!res?.accepted) throw new Error("prompt 未受理：" + JSON.stringify(res));
    },
  });

  // 桥接生命周期挂在插件 effect 上：插件停/重载 → 自动停 consume
  ctx.effect(() => {
    if (problems.length === 0) bridge.start();
    return () => bridge.stop();
  });

  // 名册定时刷新（roster_interval_min 分钟，0/未配=默认 60；-1 关闭）
  const intervalMin = cfgValue(config.roster_interval_min) === undefined ? 60 : Number(cfgValue(config.roster_interval_min));
  if (problems.length === 0 && intervalMin > 0) {
    ctx.effect(() => ctx.timer.interval(() => { bridge.refreshRoster().catch(() => {}); }, intervalMin * 60_000));
  }

  ctx.tools.register(textTool(
    "fleet_status",
    "查看本机「Agent 调度-飞书群」桥接的运行状态：是否在监听群消息、会话绑定、路条闸、名册、最近收到的任务与日志。",
    {},
    async () => bridge.statusText(),
    () => true
  ));

  ctx.tools.register(textTool(
    "fleet_send",
    "向 Agent 调度群发消息，正文自动带本机 [设备名] 署名；可 @ 某个 bot 或人（mention_open_id 或 mention_name 二选一，name 走名册模糊匹配）。身份默认按配置 send_identity（默认 bot；仅在需要以真人身份发言时才显式传 user）。给其它设备 agent 派活时正文必须带路条 [任务ID|发起人|派发深度N]。从会话内调用时自动登记回执：对端在该消息线程回 [bot-reply] 会注回本会话。",
    {
      text: { type: "string", required: true, description: "要发送的正文（纯文本；@ 提及用 mention_open_id/mention_name 参数，不要手写 <at> 标签）" },
      mention_open_id: { type: "string", description: "要 @ 的目标 open_id（ou_ 开头）" },
      mention_name: { type: "string", description: "要 @ 的目标名称（从群名册模糊匹配，如「客户」「办公机」）；与 mention_open_id 同时给时以 open_id 为准" },
      chat_id: { type: "string", description: "目标群 ID；省略则发到插件配置的群" },
      identity: { type: "string", description: "本次发送身份：bot（默认，agent 间消息）或 user（需以真人身份发言时）" },
    },
    async (args) => {
      const text = String(args?.text || "").trim();
      if (!text) return "text 不能为空";
      const initiator = typeof ctx.agents?.currentInitiator === "function" ? ctx.agents.currentInitiator() : undefined;
      const r = await bridge.send({
        text,
        mentionOpenId: args.mention_open_id || null,
        mentionName: args.mention_name || null,
        chatId: args.chat_id || null,
        identity: args.identity || null,
        ownerSessionId: initiator?.id || initiator?.sessionId || null,
      });
      return r.content;
    }
  ));

  ctx.tools.register(textTool(
    "fleet_online",
    "查看舰队里各设备最近一次被证实在线的时间（问-答机制：对方回答「在」才算在线）。也可用 action=ping 主动问一圈谁在线。",
    {
      action: { type: "string", description: "show=看已知在线状态（默认），ping=主动问一圈" },
    },
    async (args) => {
      const act = (args?.action || "show");
      if (act === "ping") {
        const rows = bridge.getRoster()?.members || [];
        const bots = rows.filter((m) => m.type === "bot" && m.open_id !== cfgValue(config.bot_open_id));
        const out = [];
        for (const b of bots) {
          const ok = await bridge.askOnline(b.open_id, "ping");
          out.push("- " + (b.name || b.open_id) + "  " + (ok ? "🟢 在" : "🔴 没应答"));
        }
        return out.length ? "问了一圈：\n" + out.join("\n") : "群里没有别的 bot。";
      }
      const rows = bridge.getRoster()?.members || [];
      const lines = rows.filter((m) => m.type === "bot").map((m) => {
        const on = bridge.isPeerOnline(m.open_id);
        return "- " + m.name + "  " + (on ? "🟢 在线" : "⚪ 未知（没问过或没应答）");
      });
      return "设备在线状态（问-答机制）：\n" + (lines.join("\n") || "（名册为空）")
        + "\n提示：派活时会自动先问「在吗」，没应答就留言。";
    },
    () => true
  ));

  ctx.tools.register(textTool(
    "fleet_roster",
    "查看/刷新「Agent 调度群」成员名册（群里的机器人与人名 + open_id + 别名）。action=show 显示缓存，action=refresh 现拉再显示。别名可写进 ~/.dsh/fleet-feishu/roster.json 对应成员的 aliases 数组，供 mention_name 模糊匹配。",
    {
      action: { type: "string", description: "show=读缓存名册（默认），refresh=调飞书接口现拉再显示" },
    },
    async (args) => {
      if ((args?.action || "show") === "refresh") {
        const r = await bridge.refreshRoster();
        if (!r.ok) return "刷新失败（详见 fleet_status 日志；常见原因：应用缺 im:chat scope 或 user 身份过期）。";
      }
      const ro = bridge.getRoster();
      if (!ro) return "名册为空。用 action=refresh 拉取。";
      const lines = (ro.members || []).map((m) =>
        "- " + m.name + " [" + m.type + "] " + m.open_id + (m.app_id ? " app=" + m.app_id : "") + (m.aliases?.length ? " 别名:" + m.aliases.join(",") : ""));
      const trunc = ro.truncations?.length ? "\n⚠️ 服务端截断：" + JSON.stringify(ro.truncations) : "";
      return "群名册 " + (ro.members || []).length + " 员（" + new Date(ro.updated_at).toLocaleString("sv-SE") + "，" + ro.identity + " 身份，chat=" + ro.chat_id + "）：\n" + lines.join("\n") + trunc;
    },
    () => true
  ));

  return () => bridge.stop();
}


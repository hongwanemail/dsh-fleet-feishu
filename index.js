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
import { createBridge, makeLogger, runtimeDir } from "./bridge.js";

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
export const Config = Schema.object({
  device_name: Schema.string().default("agent"),
  chat_id: Schema.string().default(""),
  bot_open_id: Schema.string().default(""),
  task_timeout_sec: Schema.number().default(300),
  max_reply_chars: Schema.number().default(3500),
  task_max_depth: Schema.number().default(3),
  receipt_window_min: Schema.number().default(45),
  roster_interval_min: Schema.number().default(60),
  send_identity: Schema.string().default("bot"),
  reply_identity: Schema.string().default("bot"),
  reply_reject: Schema.boolean().default(true),
  session_id: Schema.string().default(""),
  headless_profile: Schema.string().default(""),
  headless_env_file: Schema.string().default(""),
  headless_workspace: Schema.string().default(""),
  lark_entry: Schema.string().default(""),
  dsh_entry: Schema.string().default(""),
  // Presence（MQTT 风格在线感知，载体=多维表格心跳表）：
  // 填 base_token + table_id 即启用；留空 = 完全不启用（零开销）
  presence_base_token: Schema.string().default(""),
  presence_table_id: Schema.string().default(""),
  presence_interval_sec: Schema.number().default(60),
  presence_ttl_sec: Schema.number().default(90),
  presence_version: Schema.string().default(""),
});

function checkConfig(config) {
  const problems = [];
  if (!config.device_name || config.device_name === "未命名设备") problems.push("device_name 未设置（群里署名用）");
  if (!/^oc_[\w-]+$/.test(config.chat_id || "")) problems.push("chat_id 未设置或不是 oc_ 开头的群 ID");
  if (!/^ou_[\w-]+$/.test(config.bot_open_id || "")) problems.push("bot_open_id 未设置或不是 ou_ 开头");
  if (typeof config.task_timeout_sec !== "number" || config.task_timeout_sec <= 0) problems.push("task_timeout_sec 必须为正数");
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
  const intervalMin = config.roster_interval_min === undefined ? 60 : Number(config.roster_interval_min);
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
    "fleet_presence",
    "查看舰队各设备的在线状态（Presence 心跳表）：每台设备的 last_seen、状态（在线/离线由 TTL 判定）、当前任务、插件版本。用于派活前确认对方是否在线，避免“消息发出去没人接”。未配置心跳表时返回未启用。",
    {},
    async () => {
      const pres = bridge.presence;
      if (!pres || !pres.enabled()) {
        return "Presence 未启用：在插件配置里填 presence_base_token 与 presence_table_id（多维表格的 base_token 与 table_id）后生效。";
      }
      const rows = await pres.list();
      if (!rows.length) return "心跳表里还没有记录（各设备上线后会自动写入）。";
      const now = Date.now();
      const lines = rows.map((r) => {
        const online = pres.judgeOnline(r, now);
        const last = r.lastSeen ? r.lastSeen.replace("T", " ").slice(0, 19) : "(未知)";
        return "- " + (r.device || r.alias || "(未命名)")
          + "  " + (online ? "🟢 在线" : "🔴 离线")
          + "  last_seen=" + last
          + "  状态=" + (r.status || "?")
          + (r.task ? "  最后任务=" + r.task : "")
          + (r.version ? "  版本=" + r.version : "")
          + (r.appId ? "  app=" + r.appId.slice(0, 10) + "…" : "");
      });
      return "舰队在线状态（TTL " + Math.round(pres.ttlMs() / 1000) + "s，超时判离线）：\n" + lines.join("\n");
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

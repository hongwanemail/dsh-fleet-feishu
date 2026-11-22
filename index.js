// fleet-feishu —— 把本机 DSH 接进飞书群（REST 模式，不依赖 lark-cli）
//
// 验收标准（2026-11-22 宏万拍板，见 projects/飞书飞派插件.md）：
//   任何人可装：插件页 → 添加插件 → 填 GitHub 地址 → 装上 → 配置页填
//   【App ID】+【App Secret】→ 保存 → 插件自动找到机器人在哪个群 → 在群里报道
//   → 监控群消息 → 有人 @ 它就干活 → 完成后回复到群里。
//   插件不做重启；需要重启时提醒用户手动重启。
//
// 与旧版（v1.9.x，lark-cli 模式）的差别：
//   旧版要求用户先装 lark-cli、扫码登录、再手填 chat_id / bot_open_id ——
//   对「任何人可用」的开源插件是隐性门槛。新版全部走飞书开放平台 REST。
//   旧实现保留在 bridge.js（lark-cli 模式），当前不再引用。

import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { FeishuRest, cfgValue } from "./feishuRest.js";
import { createRestBridge } from "./bridgeRest.js";

export const name = "fleet-feishu";
export const inject = ["tools", "timer"];

export const Config = Schema.object({
  // ===== 客户端可编辑的两个字段（volatile 才会出现在配置表单里）=====
  app_id: Schema.string().default("")
    .description("飞书应用 App ID（cli_ 开头）。在飞书开放平台「凭证与基础信息」里复制。")
    .volatile(),
  app_secret: Schema.string().default("")
    .description("飞书应用 App Secret。同上页面复制；只保存在本机，不会外传。")
    .volatile(),

  // ===== 以下不在表单里显示，用默认值即可（改要改 profile 的 cordis.patch.yml）=====
  device_name: Schema.string().default("")
    .description("群里署名；留空 = 自动取本机主机名。"),
  task_timeout_sec: Schema.number().default(300)
    .description("单任务超时秒数。"),
  poll_interval_sec: Schema.number().default(3)
    .description("群消息轮询间隔秒数（建议 ≥2）。"),
  task_max_depth: Schema.number().default(3)
    .description("agent 派活的深度上限。"),
  max_reply_chars: Schema.number().default(3500)
    .description("回帖正文上限字符数。"),
  dsh_entry: Schema.string().default("")
    .description("dsh 可执行入口绝对路径；留空 = 自动探测。"),
});

/** 工具封装：回答是字符串，渲染为一段文本。
 *  官方规范：output.render 必须提供（否则工具调用报
 *  "output.render failed: userRender is not a function"）。 */
function textTool(name, description, parameters, execute) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value ?? "") }],
    },
    async execute(args) {
      return String(await execute(args));
    },
  });
}

/** 飞书 @ 提及的正文片段。 */
function atTag(openId, name) {
  return '<at user_id="' + openId + '">' + (name || "") + "</at>";
}

export function apply(ctx, config) {
  const dir = (() => {
    try {
      const p = os.homedir() + "/.dsh/fleet-feishu";
      return p;
    } catch {
      return ".dsh/fleet-feishu";
    }
  })();
  const log = (m) => {
    const line = "[fleet-feishu] " + m;
    console.log(line);
    try {
      fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
      fs.appendFileSync(path.join(dir, "logs", "bridge.log"), "[" + new Date().toISOString() + "] " + m + "\n", "utf8");
    } catch {}
  };

  const appId = String(cfgValue(config.app_id) || "").trim();
  const appSecret = String(cfgValue(config.app_secret) || "").trim();
  const deviceName = String(cfgValue(config.device_name) || "").trim() || os.hostname() || "agent";

  if (!appId || !appSecret) {
    log("未配置 App ID / App Secret —— 桥保持休眠。请在「插件 → 飞书飞派」的配置页填入后保存，再重启 DSH 客户端。");
  }

  const rest = new FeishuRest({ appId, appSecret, log });
  const bridge = createRestBridge({
    rest,
    log,
    options: {
      deviceName,
      dir,
      dshEntry: cfgValue(config.dsh_entry),
      taskTimeoutSec: Number(cfgValue(config.task_timeout_sec)) || 300,
      pollIntervalMs: (Number(cfgValue(config.poll_interval_sec)) || 3) * 1000,
      maxDepth: Number(cfgValue(config.task_max_depth)) || 3,
      maxReplyChars: Number(cfgValue(config.max_reply_chars)) || 3500,
      // 配置变了要提醒用户手动重启（插件自己不重启）
      getConfig: () => ({
        appId: String(cfgValue(config.app_id) || "").trim(),
        appSecret: String(cfgValue(config.app_secret) || "").trim(),
      }),
    },
  });

  ctx.effect(() => {
    if (appId && appSecret) {
      bridge.start();
      log("桥接已启动（设备名 " + deviceName + "）");
    }
    return () => bridge.stop();
  });

  // ---------- 工具 ----------

  ctx.tools.register(textTool(
    "fleet_status",
    "查看本机「Agent 调度-飞书群」桥接的运行状态：是否在监听群消息、bot 身份、已处理的群与任务、最近错误。",
    {},
    async () => {
      const s = bridge.status();
      const lines = [
        "运行中: " + (s.running ? "是" : "否"),
        "设备名: " + s.deviceName,
        "App ID: " + (appId ? appId : "（未配置）"),
        "bot open_id: " + (s.botOpenId || "（未探测到）"),
        "监控的群: " + (s.chatIds.length ? s.chatIds.map((c) => c + " " + (s.chatNames[c] || "")).join(", ") : "（无）"),
        "已处理任务: " + s.processed + " 条",
        "dsh 入口: " + (s.dshEntry || "（未找到）"),
      ];
      if (s.lastError) lines.push("最近错误: " + s.lastError);
      return lines.join("\n");
    }
  ));

  ctx.tools.register(textTool(
    "fleet_send",
    "向 Agent 调度群发消息（bot 身份）。可 @ 某个 bot 或人（mention_open_id）。给其它设备 agent 派活时正文必须带路条 [任务ID|发起人|派发深度N]。",
    {
      text: { type: "string", required: true, description: "要发送的正文（纯文本；@ 提及用 mention_open_id 参数，不要手写标签）" },
      mention_open_id: { type: "string", description: "要 @ 的目标 open_id（ou_ 开头）" },
      chat_id: { type: "string", description: "目标群 ID；省略则发到插件监控的群" },
    },
    async (args) => {
      const text = String(args?.text || "").trim();
      if (!text) return "text 不能为空";
      const s = bridge.status();
      let chatId = String(args?.chat_id || "").trim();
      if (!chatId) {
        if (!s.chatIds.length) return "没有可用的群（机器人还没被拉进群，或尚未探测成功）";
        chatId = s.chatIds[0];
      }
      let body = "[" + deviceName + "] " + text;
      if (args?.mention_open_id) body = atTag(args.mention_open_id) + " " + body;
      try {
        const id = await rest.sendToChat(chatId, body);
        return "已发送（chat=" + chatId + "，message_id=" + id + "）";
      } catch (e) {
        return "发送失败：" + String(e.message || e).slice(0, 300);
      }
    }
  ));

  ctx.tools.register(textTool(
    "fleet_roster",
    "查看「Agent 调度群」成员名册（机器人与人名 + open_id + app_id）。action=show 显示缓存，action=refresh 现拉再显示。",
    {
      action: { type: "string", description: "show=读缓存名册（默认），refresh=调飞书接口现拉再显示" },
    },
    async (args) => {
      const s = bridge.status();
      if (!s.chatIds.length) return "还没有探测到群（机器人是否已加入群？）。";
      const chatId = s.chatIds[0];
      let members = [];
      try {
        members = await rest.listMembers(chatId);
      } catch (e) {
        return "拉取失败：" + String(e.message || e).slice(0, 300);
      }
      const lines = members.map((m) =>
        "- " + (m.name || "?") + " [" + (m.appId ? "bot" : "user") + "] " + m.memberId + (m.appId ? " app=" + m.appId : ""));
      return "群名册 " + members.length + " 员（chat=" + chatId + "，" + (s.chatNames[chatId] || "") + "）：\n" + lines.join("\n");
    }
  ));

  ctx.tools.register(textTool(
    "fleet_online",
    "查看各设备最近一次在群里发言的时间（群里谁活跃＝谁在线）。action=show 看记录，action=ping 主动问一圈谁在线。",
    {
      action: { type: "string", description: "show=看已知在线状态（默认），ping=主动问一圈" },
    },
    async (args) => {
      const s = bridge.status();
      const peers = bridge.peerActivity();
      if ((args?.action || "show") === "ping") {
        const out = [];
        for (const p of peers) {
          const ok = await bridge.askOnline(p.openId);
          out.push("- " + (p.name || p.openId) + "  " + (ok ? "🟢 在" : "🔴 没应答"));
        }
        return out.length ? "问了一圈：\n" + out.join("\n") : "群里没有别的 bot。";
      }
      const lines = peers.map((p) => {
        const on = bridge.isPeerOnline(p.openId);
        return "- " + (p.name || p.openId) + "  " + (on ? "🟢 在线" : "⚪ 未知") + "  最后发言 " + (p.lastAt ? new Date(p.lastAt).toLocaleString("zh-CN") : "无");
      });
      return "设备在线状态（按群内发言推断）：\n" + (lines.join("\n") || "（还没看到别的 bot 发言）");
    }
  ));

  return () => bridge.stop();
}

// bridgeRest.js —— 飞书群桥接（REST 模式，不依赖 lark-cli）
//
// 目标（验收标准，2026-11-22 宏万拍板）：
//   用户只填 App ID + App Secret → 插件自动找到机器人在哪个群 → 在群里报道 →
//   监控群消息 → 有人 @ 它就干活 → 完成后回复到群里。
//   插件不做重启；需要重启时由用户手动重启。
//
// 安全边界（与旧 lark-cli 版一致，不可丢）：
//   1) 只处理【@ 了自己】的消息（mentions 含本 bot 的 open_id）
//   2) 只处理顶层消息：回复/引用继承的 mentions 会造成回环刷屏 → 拒收
//   3) 自己发的消息不处理；正文带 [bot-reply] 前缀的不处理
//   4) agent（应用身份）派活必须带路条 [任务ID|发起人|派发深度N]；真人消息直接执行
//   5) 派发深度硬闸：超过上限就拒绝，转人工
//
// 与旧版的差别：收发消息全部走飞书开放平台 REST（tenant_access_token），
// 不需要用户装 lark-cli、不需要扫码登录 —— 这是「任何人可用」的前提。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import readline from "node:readline";

const TASK_PASS_RE = /任务ID\s*[|｜]\s*([\w.\-]+)\s*[|｜]\s*([^|｜]+?)\s*[|｜]\s*派发深度\s*(\d+)/;
const BOT_REPLY_TAG = "[bot-reply]";

/** 找出 dsh 的可执行入口（node + lib/bin.js）。 */
export function resolveDshEntry(explicit) {
  const p = String(explicit || "").trim();
  if (p && existsSync(p)) return p;
  const win = process.platform === "win32";
  const cands = [];
  if (win && process.env.APPDATA) {
    cands.push(join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
  } else {
    for (const root of [join(process.env.HOME || "", ".npm-global", "lib", "node_modules"), "/usr/local/lib/node_modules", "/opt/homebrew/lib/node_modules"]) {
      if (root && existsSync(root)) cands.push(join(root, "@deepseek-ai", "dsh", "lib", "bin.js"));
    }
  }
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

/** 从正文里剥掉 @_user_N 占位符，剩下的才是任务文本。 */
export function stripMentions(text) {
  return String(text || "").replace(/@_user_\d+/g, " ").replace(/\s+/g, " ").trim();
}

/** 任务是否 @ 了我。 */
export function mentionsMe(msg, botOpenId) {
  if (!botOpenId) return false;
  for (const m of msg.mentions || []) {
    if (m.id === botOpenId) return true;
  }
  return false;
}

/** 解析路条。 */
export function parseTaskPass(text) {
  const m = String(text || "").match(TASK_PASS_RE);
  if (!m) return null;
  return { taskId: m[1], from: m[2].trim(), depth: Number(m[3]) || 0 };
}

export function createRestBridge({ rest, log, hooks = {}, options = {} }) {
  const pollMs = Number(options.pollIntervalMs) > 0 ? Number(options.pollIntervalMs) : 3000;
  const taskTimeoutSec = Number(options.taskTimeoutSec) > 0 ? Number(options.taskTimeoutSec) : 300;
  const maxDepth = Number(options.maxDepth) > 0 ? Number(options.maxDepth) : 3;
  const maxReplyChars = Number(options.maxReplyChars) > 0 ? Number(options.maxReplyChars) : 3500;
  const onlineWindowMs = (Number(options.onlineWindowMin) > 0 ? Number(options.onlineWindowMin) : 5) * 60_000;
  const deviceName = String(options.deviceName || "agent");
  const dir = options.dir || join(os.homedir(), ".dsh", "fleet-feishu");
  const getConfig = typeof options.getConfig === "function" ? options.getConfig : null;
  const dshEntry = resolveDshEntry(options.dshEntry);

  try { mkdirSync(join(dir, "logs"), { recursive: true }); } catch {}

  const st = {
    running: false,
    stopped: false,
    chatIds: [],
    chatNames: {},
    botOpenId: "",
    appId: rest.appId,
    seen: new Set(),
    seenOrder: [],
    primed: false,
    sessionId: "",
    cwd: "",
    lastPollAt: 0,
    lastError: "",
    processed: 0,
    peers: new Map(),      // open_id -> { name, lastAt }
    pendingHello: new Map(), // token -> { openId, at }
    queue: Promise.resolve(),
  };

  /** 记住谁在群里说话了（REST 轮询天然看得到群里所有消息）。 */
  function notePeer(msg) {
    if (!msg.senderId) return;
    if (msg.senderId === st.botOpenId) return;
    const name = (msg.senderName || "") || (msg.mentions.find((m) => m.id === msg.senderId) || {}).name || "";
    const prev = st.peers.get(msg.senderId) || { name: "", lastAt: 0 };
    st.peers.set(msg.senderId, { name: name || prev.name, lastAt: Date.now() });
  }

  /** 名册：群里说话的部分（含 bot）。 */
  function peerActivity() {
    const out = [];
    for (const [openId, p] of st.peers) {
      const isBot = /^(ou_|cli_)/.test(openId) && p.name !== "";
      out.push({ openId, name: p.name, lastAt: p.lastAt, isBot });
    }
    return out;
  }

  /** 判定在线：最近 onlineWindowMs 毫秒内在群里发言过。 */
  function isPeerOnline(openId) {
    const p = st.peers.get(openId);
    if (!p || !p.lastAt) return false;
    return Date.now() - p.lastAt <= onlineWindowMs;
  }

  /** 主动问一句「在吗」：发 HELLO，等下一轮轮询看是否有 PONG。 */
  async function askOnline(openId, prefix = "ping") {
    if (!st.chatIds.length) return false;
    const token = prefix + "-" + Date.now().toString(36);
    st.pendingHello.set(token, { openId, at: Date.now() });
    try {
      await rest.sendToChat(st.chatIds[0], "[HELLO|" + token + "] 在吗？");
    } catch {
      return false;
    }
    return false; // 答案在下一轮轮询里回填
  }

  function remember(id) {
    if (!id) return false;
    if (st.seen.has(id)) return false;
    st.seen.add(id);
    st.seenOrder.push(id);
    while (st.seenOrder.length > 500) st.seen.delete(st.seenOrder.shift());
    return true;
  }

  async function send(chatId, text) {
    let body = String(text || "");
    if (body.length > maxReplyChars) body = body.slice(0, maxReplyChars) + "…（已截断）";
    try {
      return await rest.sendToChat(chatId, body);
    } catch (e) {
      log("发消息失败：" + String(e.message || e).slice(0, 160));
      return "";
    }
  }

  /**
   * 自举：换 token → 找群 → 找自己 → 报道。
   * 找不到群多半是「机器人还没被拉进群」——日志与报道里要说清楚。
   */
  async function bootstrap() {
    await rest.ensureToken();
    const chats = await rest.listChats();
    if (!chats.length) {
      st.lastError = "应用没有加入任何群：请先在飞书里把机器人拉进目标群";
      log("❌ " + st.lastError);
      return false;
    }
    st.chatIds = chats.map((c) => c.chatId);
    for (const c of chats) st.chatNames[c.chatId] = c.name;

    // 找自己在群里的 open_id（按 app_id 匹配群成员）
    for (const chatId of st.chatIds) {
      try {
        const self = await rest.findSelfInChat(chatId);
        if (self.openId) {
          st.botOpenId = self.openId;
          break;
        }
      } catch (e) {
        log("群成员读取失败（" + chatId + "）：" + String(e.message || e).slice(0, 120));
      }
    }
    if (!st.botOpenId) {
      st.lastError = "找到群了，但群成员里没有本应用的 bot（确认机器人本体在群里，而不是另一个应用）";
      log("❌ " + st.lastError);
      return false;
    }

    // 群里报道（验收标准第 8 条）
    const report =
      "✅ [" + deviceName + "] 我已上线，已加入 " + st.chatIds.length + " 个群。\n" +
      "· 我的 open_id：" + st.botOpenId + "\n" +
      "· 用法：在群里 @" + deviceName + " 派任务，我会执行完回复到群里。\n" +
      "· 日志目录：" + dir;
    for (const chatId of st.chatIds) {
      await send(chatId, report);
    }
    log("✅ 已报到：" + st.chatIds.length + " 个群，bot open_id=" + st.botOpenId);
    st.lastError = "";
    return true;
  }

  /** 轮询一轮：拉消息 → 处理新消息。 */
  async function pollOnce() {
    for (const chatId of st.chatIds) {
      let msgs;
      try {
        msgs = await rest.listChatMessages(chatId, { pageSize: 30 });
      } catch (e) {
        st.lastError = String(e.message || e).slice(0, 200);
        log("拉消息失败（" + chatId + "）：" + st.lastError);
        continue;
      }
      // 飞书按时间倒序返回
      for (const m of msgs.slice().reverse()) {
        if (!remember(m.messageId)) continue;
        notePeer(m);
        if (!st.primed) continue;   // 第一轮只建立基线，不回放历史
        // PONG 回填：有人回“在”就算位线了
        const pong = String(m.text || "").match(/\[PONG\|([A-Za-z0-9_.\-]+)\]/);
        if (pong) {
          const pend = st.pendingHello.get(pong[1]);
          if (pend) {
            st.peers.set(pend.openId, { name: st.peers.get(pend.openId)?.name || "", lastAt: Date.now() });
            st.pendingHello.delete(pong[1]);
            continue;
          }
        }
        handleMessage(m).catch((e) => log("处理消息异常：" + String(e.message || e).slice(0, 160)));
      }
    }
    st.primed = true;
    st.lastPollAt = Date.now();
    // 配置被改了：插件自己不重启，只提醒用户手动重启
    if (typeof getConfig === "function") {
      const now = getConfig();
      if (st.lastSeenAppId !== undefined && (now.appId !== st.lastSeenAppId || now.appSecret !== st.lastSeenAppSecret)) {
        const tip = "⚠ [" + deviceName + "] 配置已更新（App ID / App Secret）。请**手动重启 DSH 客户端**后生效。";
        log("配置已变更，需用户手动重启 DSH 客户端");
        for (const c of st.chatIds) await send(c, tip);
      }
      st.lastSeenAppId = now.appId;
      st.lastSeenAppSecret = now.appSecret;
    }
  }

  /** 处理一条消息。 */
  async function handleMessage(m) {
    if (m.deleted) return;
    if (m.senderId === st.botOpenId) return;                       // 自己发的
    if (String(m.text || "").trim().startsWith(BOT_REPLY_TAG)) return; // 回执前缀
    if (!mentionsMe(m, st.botOpenId)) return;                     // 没 @ 我 → 不理

    const task = stripMentions(m.text);
    if (!task) return;

    // 群内指令
    if (task.startsWith("/status")) {
      await send(m.chatId, "[" + deviceName + "] 运行中: 是（bot open_id=" + st.botOpenId + "）\n已处理任务 " + st.processed + " 条");
      return;
    }

    // agent 派活必须带路条；真人消息直接执行
    const isAgent = m.senderType === "app" || m.senderType === "bot";
    const pass = parseTaskPass(m.text);
    if (isAgent && !pass) {
      await send(m.chatId, "⚠️ [" + deviceName + "] 来自 agent 的消息缺少路条（[任务ID|发起人|派发深度N]），已拒绝。");
      return;
    }
    if (pass && pass.depth > maxDepth) {
      await send(m.chatId, "⚠️ [" + deviceName + "] 路条深度超限（" + pass.depth + " > " + maxDepth + "），已拒绝，请升级给人处理。");
      return;
    }

    st.processed++;
    enqueue(() => runTask(task, m.chatId, pass));
  }

  /** 串行执行任务。 */
  function enqueue(fn) {
    st.queue = st.queue.then(fn).catch((e) => log("任务队列异常：" + String(e.message || e).slice(0, 160)));
  }

  function runTask(task, chatId, pass) {
    return (async () => {
      await send(chatId, "✅ [" + deviceName + "] 开始处理（最长 " + taskTimeoutSec + " 秒）…");
      if (!dshEntry) {
        await send(chatId, "⚠️ [" + deviceName + "] 找不到 dsh 可执行入口，任务未执行。");
        return;
      }
      const node = process.execPath;
      const args = [dshEntry, "headless", "--json"];
      if (st.sessionId) args.push("--session-id", st.sessionId);
      args.push(task);
      const cwd = st.cwd || process.env.DSH_WORKSPACE || os.homedir();
      const result = await new Promise((finish) => {
        const child = spawn(node, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, cwd, env: { ...process.env } });
        let answer = null, runErr = null, newSid = "", out = "", timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, taskTimeoutSec * 1000);
        readline.createInterface({ input: child.stdout }).on("line", (line) => {
          out += line + "\n";
          let evt;
          try { evt = JSON.parse(line); } catch { return; }
          if (evt.type === "session" && evt.sessionId) newSid = evt.sessionId;
          else if (evt.type === "final") { answer = evt.text || ""; if (evt.reason && evt.reason.kind === "error") runErr = (evt.reason.error && evt.reason.error.message) || "未知错误"; }
          else if (evt.type === "error") runErr = evt.error || evt.message || String(evt);
        });
        child.stderr.on("data", (d) => { if (!runErr) runErr = String(d).slice(0, 300); });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (timedOut) runErr = runErr || "任务超时（>" + taskTimeoutSec + "s），已终止";
          else if (code !== 0 && !runErr) runErr = "dsh headless 退出码 " + code;
          const m = runErr ? String(runErr).match(/recorded in "([^"]+)"/) : null;
          if (m && m[1] !== cwd) { st.cwd = m[1]; finish({ answer, runErr: null, timedOut, newSid }); return; }
          finish({ answer, runErr, timedOut, newSid });
        });
        child.on("error", (e) => { clearTimeout(timer); finish({ answer: null, runErr: String(e.message || e), timedOut: false, newSid: "" }); });
      });
      if (result.newSid && result.newSid !== st.sessionId) {
        st.sessionId = result.newSid;
        try { writeFileSync(join(dir, "state.json"), JSON.stringify({ session_id: st.sessionId, cwd: st.cwd }), "utf8"); } catch {}
      }
      try { mkdirSync(join(dir, "outbox"), { recursive: true }); writeFileSync(join(dir, "outbox", Date.now() + ".json"), JSON.stringify({ task, pass, answer: result.answer, runErr: result.runErr, at: Date.now() }), "utf8"); } catch {}
      if (result.runErr && !result.answer) await send(chatId, "⚠️ [" + deviceName + "] 任务失败：" + String(result.runErr).slice(0, 400));
      else if (!result.answer) await send(chatId, "⚠️ [" + deviceName + "] 任务完成但没有输出。");
      else await send(chatId, "🔗 [" + deviceName + "] 结果：\n" + result.answer);
    })();
  }

  async function loop() {
    while (!st.stopped) {
      try {
        if (!st.chatIds.length) {
          await bootstrap();
        } else {
          await pollOnce();
        }
      } catch (e) {
        st.lastError = String(e.message || e).slice(0, 200);
        log("轮询异常：" + st.lastError);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  return {
    start() {
      if (st.running) return;
      st.running = true;
      st.stopped = false;
      loop().catch((e) => log("桥接主循环退出：" + String(e.message || e).slice(0, 160)));
    },
    stop() {
      st.stopped = true;
      st.running = false;
    },
    bootstrap,
    pollOnce,
    peerActivity,
    isPeerOnline,
    askOnline,
    status() {
      return {
        running: st.running,
        chatIds: st.chatIds,
        chatNames: st.chatNames,
        botOpenId: st.botOpenId,
        deviceName,
        lastPollAt: st.lastPollAt,
        lastError: st.lastError,
        processed: st.processed,
        dshEntry: dshEntry || "",
      };
    },
  };
}

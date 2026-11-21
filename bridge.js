// fleet-feishu 桥接核心：进程内飞书群桥接（v1.2，2026-11-15）
// 设计来源：agents/feishu-fleet/bridge.py 的已验证实现（M0/M1/M2 实测），移植为 ESM。
// v1.1 新增：路条硬闸（协议层三道闸落地）、群内指令 /new /reset /status /roster、
//           配置固定会话 session_id、群成员名册（roster.json，user 身份拉取、bot 兜底）。
// v1.2 新增：①身份归位——回执改为 **bot 应用身份优先**（user 兜底），发起派活 send_identity 可配；
//           ②回执注回——fleet_send 记录 message_id→发起会话，收到对方对该消息的回复时
//             经 sessionController.prompt **注回发起会话**（桌面端"派完不用盯群"的关键）；
//           ③分步断点续作——超时任务记入 resume.json，群内 /resume 沿同一会话续跑；
//           ④多平台入口探测（macOS/Linux 常见 npm 全局前缀 + PATH 扫描），为开源装机铺路。
// 固化的坑（全部实测过，别删）：
//   1) 路由闸：群消息 + 顶层消息(reject reply_to/root_id) + mentions 含本 bot + [bot-reply] 前缀拒收
//      —— reply 会继承被回复消息的 mentions，用 user 身份回复的回执会再次命中路由 → 死循环刷屏
//   2) 直调 node + js 入口，不经 .cmd —— cmd 会把任务文本里的 | 当管道（路条必含竖线）→ exit 255 无输出
//   3) consume 的 stdin 保持打开 —— unbounded 模式下 stdin 关闭 = 退出信号
//   4) spawn 环境清掉 HERMES_HOME/OPENCLAW_HOME —— 残留会导致 lark-cli 秒退
//   5) v1.2：回执/拦截正文带 [bot-reply] 前缀（路由与注回识别都靠它）；署名 [设备名]
//      —— 身份顺序 v1.1 为 user 优先（旧桥只认 user），v1.2 改 bot 优先（身份归位，旧桥收到也只当通知）
//   6) v1.1：路条拦截回复必须走 replyText（带 [bot-reply] 前缀），否则被对端路由命中 → 拦截回复风暴
//   7) v1.1：lark-cli 的 @file 参数有白名单（cwd/账户temp/~/files），DSH 宿主 cwd 不可控
//      → 发送/回复正文一律用 `--text -` 走 stdin 传入，不落临时文件（v1.0.0 的 @文件 写法在插件内必挂）
export { };

const TASK_PASS_RE = /任务ID\s*[|｜]\s*([\w.\-]+)\s*[|｜]\s*([^|｜]+?)\s*[|｜]\s*派发深度\s*(\d+)/;

// 解析路条 [任务ID|X|Y|派发深度N]（全半角竖线均可，兼容正文任意位置）
export function parseTaskPass(text) {
  const m = String(text || "").match(TASK_PASS_RE);
  if (!m) return null;
  return { taskId: m[1], from: m[2].trim(), depth: Number(m[3]) };
}

const COMMAND_RE = /^\/(new|reset|status|roster|resume)\b/i;

// v1.2 修正（E2E 发现）：回执正文格式是 "[设备名] [bot-reply] …"（署名在前！），
// v1.1 的 content.startsWith("[bot-reply]") 双保险闸与 v1.2 收据匹配都写歪了——
// 防循环一直实际靠 reply_to 单闸。统一用 isBotReply 识别：容忍 0..N 个前导 [xxx] 标签。
export function isBotReply(text) {
  return /^\s*(\[[^\]]*\]\s*)*\[bot-reply\]/.test(String(text || ""));
}
export function cleanReceiptBody(text) {
  let s = String(text || "");
  s = s.replace(/^\s*\[[^\]]*\]\s*(?=\[bot-reply\])/, "");
  s = s.replace(/^\s*\[bot-reply\]\s*/, "");
  return s;
}

// v1.2：回执分两类——"已收到"是过程通知（不注回，防噪音），"🔗 结果/⚠️ 任务失败/⚠️ 无回答"才是终态（注回）
export function isFinalReceipt(text) {
  const s = cleanReceiptBody(text);
  return s.includes("🔗 结果") || s.includes("⚠️ 任务失败") || s.includes("⚠️ 任务完成但无回答");
}

// v1.3：只有"定向派活"（@ 了具体成员/机器人）才值得登记收据——群公告/广播没人回复，登记只会污染台账
export function shouldTrackReceipt({ target, ownerSessionId }) {
  return !!target && !!ownerSessionId;
}

// v1.3：跨平台 node 解析。macOS GUI 进程 PATH 极简（/usr/bin:/bin:/usr/sbin:/sbin），
// Homebrew(nvm/volta) 的 node 不在其中 → PATH 扫描失败时走显式候选；全落空才用 Electron-as-node，
// 且 spawn 时补 ELECTRON_RUN_AS_NODE=1 兜底（Windows 的 execPath 形态已长期实测，保持原样）。
function findNode() {
  if (process.platform === "win32") return process.execPath;
  const found = findInPath("node");
  if (found) return found;
  const home = process.env.HOME || os.homedir();
  const guess = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node",
    join(home, ".volta", "bin", "node"), join(home, ".nvm", "current", "bin", "node")];
  for (const g of guess) { try { if (existsSync(g)) return g; } catch {} }
  return process.execPath; // Electron 兜底（配合 ELECTRON_RUN_AS_NODE）
}

// 路由判定（纯函数，可单元测试）。seenTaskIds: Set<string> 本机已接过的任务ID。
// 返回 { accept:false, reason, pass? } 或 { accept:true, task, pass, cmd }
export function routeEvent(evt, cfg, seenTaskIds = new Set()) {
  const rej = (reason) => ({ accept: false, reason, pass: parseTaskPass(evt?.content) });
  if (!evt || evt.chat_type !== "group") return rej("not-group");
  if (evt.chat_id !== cfg.chat_id) return rej("other-chat");
  if (evt.message_type !== "text") return rej("not-text");
  if (evt.reply_to || evt.root_id) return rej("reply-not-command");        // 顶层消息闸（防 reply 继承 mentions 自循环）
  const content = String(evt.content || "");
  if (isBotReply(content)) return rej("bot-reply");                   // 回执标记闸（v1.2：容忍 [设备名] 前缀）
  const mentions = evt.mentions || [];
  if (!mentions.some((m) => m.id === cfg.bot_open_id)) return rej("no-mention");
  const sender = evt.sender_type;
  if (sender !== "user" && sender !== "bot") return rej("unknown-sender");
  if (sender === "bot" && evt.sender_id === cfg.bot_open_id) return rej("self"); // 本 bot 自己发的（防配置成同 open_id 场景）
  const pass = parseTaskPass(content);
  const maxDepth = Number.isFinite(cfg.max_depth) ? cfg.max_depth : 3;
  if (pass) {
    if (pass.depth > maxDepth) return { ...rej("depth-exceeded"), pass };
    if (seenTaskIds.has(pass.taskId)) return { ...rej("task-visited"), pass };
  } else if (sender === "bot") {
    return rej("bot-no-task-pass");                                        // bot→agent 无路条 = 拒收（协议层路条硬闸）
  }
  const body = content.replace(/^@\S+\s*/, "").trim();
  if (!body) return rej("empty");
  let cmd = null;
  if (sender === "user" && !pass) {
    const m = body.match(COMMAND_RE);
    if (m) cmd = "/" + m[1].toLowerCase();
  }
  return { accept: true, task: body, pass, cmd };
}

// v1.2 回执注回（纯函数，可单测）：事件是否命中本机某条待回收据。
// 判据：线程回复到被跟踪的 message_id（reply_to 或 root_id 链）+ [bot-reply] 前缀 + 未过期。
export function findReceipt(evt, receipts, now = Date.now()) {
  if (!evt || !Array.isArray(receipts) || receipts.length === 0) return null;
  if (evt.chat_type !== "group") return null;
  if (!isBotReply(evt.content)) return null;
  const ref = evt.reply_to || evt.root_id;
  if (!ref) return null;
  for (const r of receipts) {
    if (r.messageId === ref && r.expires > now) return r;
  }
  return null;
}

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import readline from "node:readline";

const MAX_LOG_LINES = 2000;
const RESTART_BACKOFF_MS = [10_000, 30_000, 60_000];
const MAX_DONE_TASKS = 500;

export function runtimeDir() {
  const home = process.env.DSH_HOME || join(os.homedir(), ".dsh");
  return join(home, "fleet-feishu");
}

export function makeLogger(dir) {
  const logs = join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  const file = join(logs, "bridge.log");
  return function log(msg) {
    const line = "[" + new Date().toLocaleString("sv-SE").replace("T", " ").slice(0, 19) + "] " + msg;
    console.log(line);
    try {
      appendFileSync(file, line + "\n", "utf8");
      const all = readFileSync(file, "utf8").split("\n");
      if (all.length > MAX_LOG_LINES) writeFileSync(file, all.slice(-MAX_LOG_LINES).join("\n"), "utf8");
    } catch {}
  };
}

// v1.2：POSIX 下扫 PATH 找可执行入口（macOS/Linux 开源装机主路径；Windows 不扫）。
// npm 全局 bin 是指向包内真实 js 的符号链接，realpath 后即入口，不做路径拼接推断。
function findInPath(bin) {
  if (process.platform === "win32") return null;
  const dirs = String(process.env.PATH || "").split(":").filter(Boolean);
  for (const d of dirs) {
    const c = join(d, bin);
    try {
      const st = statSync(c);
      if (st.isFile() || st.isSymbolicLink()) {
        if (st.mode & 0o111) { try { return realpathSync(c); } catch { return c; } }
      }
    } catch {}
  }
  return null;
}

export function resolveEntry(config, kind) {
  // kind: "lark" | "dsh" —— 返回入口绝对路径，或 null（找不到则桥不启动，日志说明，不猜）
  // v1.1 修黑窗闪：lark 优先直驱 bin\lark-cli.exe 本体；run.js 启动器会 fork 出独立控制台
  // worker（黑窗一闪），只作老安装形态的回退。
  // v1.2 多平台：Windows=APPDATA npm 前缀；POSIX=HOME/npm-global、/usr/local、/opt/homebrew 常见前缀 + PATH 扫描。
  if (kind === "lark" && config.lark_entry) return config.lark_entry;
  if (kind === "dsh" && config.dsh_entry) return config.dsh_entry;
  const candidates = [];
  const win = process.platform === "win32";
  const appData = process.env.APPDATA;
  if (win && appData) {
    if (kind === "lark") {
      candidates.push(join(appData, "npm", "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe"));
      candidates.push(join(appData, "npm", "node_modules", "@larksuite", "cli", "scripts", "run.js"));
    }
    if (kind === "dsh") candidates.push(join(appData, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
  } else if (!win) {
    const roots = [
      join(process.env.HOME || "", ".npm-global", "lib", "node_modules"),
      "/usr/local/lib/node_modules",
      "/opt/homebrew/lib/node_modules",
    ].filter((r) => r && existsSync(r));
    for (const root of roots) {
      if (kind === "lark") {
        candidates.push(join(root, "@larksuite", "cli", "bin", "lark-cli"));
        candidates.push(join(root, "@larksuite", "cli", "scripts", "run.js"));
      }
      if (kind === "dsh") candidates.push(join(root, "@deepseek-ai", "dsh", "lib", "bin.js"));
    }
    const onPath = findInPath(kind === "lark" ? "lark-cli" : "dsh");
    if (onPath) candidates.push(onPath);
  }
  for (const c of candidates) { try { if (c && existsSync(c)) return c; } catch {} }
  return null;
}

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

// v1.1：headless 是独立进程，读不到桌面端 credentials，只认环境变量（M0 实测）。
// key 注入沿用 M0/M1 的 dotenv 方案：config.headless_env_file 显式指定；
// 留空按候选自动找（插件运行目录/.env、~/feishu-fleet/.env）。key 值永不入库（git），只记位置。
function loadEnvFile(config, dir) {
  const p = String(config.headless_env_file || "").trim();
  const candidates = p ? [p] : [join(dir, ".env"), join(os.homedir(), "feishu-fleet", ".env")];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    const vars = {};
    try {
      for (const line of readFileSync(c, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m && m[2] && !m[2].startsWith("#")) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {}
    return { file: c, vars };
  }
  return { file: null, vars: {} };
}

// 从可能混有进度行的 stdout 提取 JSON 对象
function extractJson(text) {
  const s = String(text || "");
  const i = s.indexOf("{");
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}

export function createBridge(config, log, hooks = {}) {
  const dir = runtimeDir();
  mkdirSync(join(dir, "inbox"), { recursive: true });
  mkdirSync(join(dir, "outbox"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });
  const stateFile = join(dir, "state.json");
  const tasksFile = join(dir, "tasks.json");
  const rosterFile = join(dir, "roster.json");
  const receiptsFile = join(dir, "receipts.json");   // v1.2 待回收据台账
  const resumeFile = join(dir, "resume.json");       // v1.2 超时任务续作台账
  const state = { sessionId: null, cwd: null };
  const saved = readJsonSafe(stateFile);
  if (saved?.session_id) state.sessionId = saved.session_id;
  if (saved?.cwd) state.cwd = saved.cwd;

  // 已接过的任务ID（防同任务回环）：持久化 tasks.json = [{id, at}]
  let doneTasks = Array.isArray(readJsonSafe(tasksFile)?.tasks) ? readJsonSafe(tasksFile).tasks : [];
  const seenTaskIds = new Set(doneTasks.map((t) => t.id));
  function markDone(taskId, from) {
    if (!taskId || seenTaskIds.has(taskId)) return;
    seenTaskIds.add(taskId);
    doneTasks.push({ id: taskId, at: Date.now(), from: from || "" });
    if (doneTasks.length > MAX_DONE_TASKS) doneTasks = doneTasks.slice(-MAX_DONE_TASKS);
    try { writeFileSync(tasksFile, JSON.stringify({ tasks: doneTasks }), "utf8"); } catch {}
  }

  const st = {
    running: false, child: null, restartTimer: null, restartIdx: 0,
    lastEventAt: null, lastTaskAt: null, queue: Promise.resolve(), stopped: false,
    roster: readJsonSafe(rosterFile) || null,
    receipts: (readJsonSafe(receiptsFile)?.receipts || []).filter((r) => r.expires > Date.now()),
    resume: readJsonSafe(resumeFile) || null,
  };
  function saveReceipts() {
    try {
      st.receipts = st.receipts.filter((r) => r.expires > Date.now()).slice(-50);
      writeFileSync(receiptsFile, JSON.stringify({ receipts: st.receipts }), "utf8");
    } catch {}
  }
  // v1.3 巡检发现：过期收据原本只在下次登记时才被清——空闲舰队会永留垃圾。
  // sweepReceipts 挂到名册定时任务上周期清扫，状态读取处即时过滤（显示不骗人）。
  function sweepReceipts() {
    const before = st.receipts.length;
    st.receipts = st.receipts.filter((r) => r.expires > Date.now());
    if (st.receipts.length !== before) saveReceipts();
  }
  function liveReceipts() {
    return st.receipts.filter((r) => r.expires > Date.now());
  }

  const larkEntry = resolveEntry(config, "lark");
  const dshEntry = resolveEntry(config, "dsh");
  // v1.3 跨平台：POSIX 下 process.execPath 是 Electron 宿主——findNode 优先真 node（PATH→显式候选），
  // 落到 Electron 时由 decorateNodeEnv 补 ELECTRON_RUN_AS_NODE=1。Windows execPath 已实测可行，保持。
  const node = findNode();
  const nodeIsElectron = node === process.execPath && !!process.versions.electron;
  function decorateNodeEnv(env) {
    if (nodeIsElectron) env.ELECTRON_RUN_AS_NODE = "1";
    return env;
  }
  const fixedSession = () => String(config.session_id || "").trim();

  function saveState() {
    try { writeFileSync(stateFile, JSON.stringify({ session_id: state.sessionId, cwd: state.cwd }), "utf8"); } catch {}
  }

  function spawnLark(args, opts = {}) {
    const env = decorateNodeEnv({ ...process.env });
    delete env.HERMES_HOME;   // 坑4：残留导致 lark-cli 秒退
    delete env.OPENCLAW_HOME;
    const stdin = opts.stdinData != null ? "pipe" : (opts.stdinHold ? "pipe" : "ignore");
    // 直驱 exe/原生入口：单跳、无 fork，黑窗不闪；run.js 等 .js 入口仍走 node 包装（POSIX 同理）
    const isJs = larkEntry && /\.js$/i.test(larkEntry);
    return spawn(isJs ? node : larkEntry, isJs ? [larkEntry, ...args] : args, {
      stdio: [stdin, "pipe", "pipe"],
      env,
      windowsHide: true,
    });
  }

  // run.js 在 Windows 上是"fork worker 后父进程退出"形态：父进程退出 ≠ worker 死。
  // worker 是 detach 的孙进程，不受 stop() 管辖 → 多轮 install/重启会积累孤儿 → 同一事件被多个 worker 重复消费。
  // 处理：启动前清掉所有孤儿 worker；父进程退出时先查有没有存活 worker，有就不重启。
  // v1.3 跨平台：POSIX（Mac/Linux）同样存在 fork worker 形态，ps -ax 匹配补上（开源硬标准：Mac 必须可用）。
  function psListWorkers() {
    return new Promise((resolve) => {
      const CONSUME_RE = /event consume im\.message\.receive_v1/;
      if (process.platform === "win32") {
        const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '(lark-cli\\.exe|run\\.js) event consume im\\.message\\.receive_v1' } | Select-Object -ExpandProperty ProcessId";
        const c = spawn("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        let out = "";
        c.stdout.on("data", (d) => { out += d; });
        c.on("close", () => resolve(out.split(/\r?\n/).map(Number).filter((n) => n > 0)));
        c.on("error", () => resolve([]));
        return;
      }
      const c = spawn("ps", ["-ax", "-o", "pid=,command="], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      c.stdout.on("data", (d) => { out += d; });
      c.on("close", () => {
        const pids = [];
        for (const line of out.split(/\r?\n/)) {
          const m = line.match(/^\s*(\d+)\s+(.*)$/);
          if (!m) continue;
          if (CONSUME_RE.test(m[2]) && !/\b(?:^|\s)ps\s+-ax\b/.test(m[2])) pids.push(Number(m[1]));
        }
        resolve(pids);
      });
      c.on("error", () => resolve([]));
    });
  }

  async function killStrayWorkers() {
    const pids = await psListWorkers();
    for (const pid of pids) {
      try { process.kill(pid); log("清理孤儿 consume worker pid=" + pid); } catch {}
    }
    if (pids.length > 0) await new Promise((r) => setTimeout(r, 1500));
    return pids.length;
  }

  function larkRun(args, timeoutMs = 60_000, stdinData = null) {
    // 坑7：正文走 stdin（--text -），不用 @文件（lark-cli 路径白名单在宿主 cwd 下必挂）
    return new Promise((resolve) => {
      if (!larkEntry) return resolve({ ok: false, detail: "lark-cli 入口未找到" });
      const child = spawnLark(args, { stdinData });
      let out = "", err = "";
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      if (stdinData != null) child.stdin.end(stdinData, "utf8");
      child.on("close", (code) => {
        clearTimeout(timer);
        const ok = /"ok"\s*:\s*true/.test(out);
        resolve({ ok, detail: (out + "\n" + err).slice(-600), stdout: out });
      });
      child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, detail: String(e) }); });
    });
  }

  async function replyText(messageId, text) {
    // 坑5（v1.2 身份归位）：回执=通知不是指令——路由对 reply_to/[bot-reply] 双拦，
    // 所以回执改 **bot 应用身份优先**（谁的机器说谁的话），user 仅兜底；[设备名] 署名 + stdin 正文。
    let body = text;
    if (!body.startsWith("[bot-reply]")) body = "[bot-reply] " + body;
    const dev = config.device_name || "agent";
    if (!body.includes("[" + dev + "]", 0)) body = "[" + dev + "] " + body;
    if (body.length > (config.max_reply_chars || 3500)) body = body.slice(0, config.max_reply_chars || 3500) + "\n…(已截断)";
    const order = config.reply_identity === "user" ? ["user", "bot"] : ["bot", "user"];
    for (const as of order) {
      const r = await larkRun(["im", "+messages-reply", "--message-id", messageId, "--text", "-", "--as", as], 60_000, body);
      if (r.ok) {
        log("回复(" + as + "身份) " + messageId.slice(0, 14) + "… -> ✅");
        return true;
      }
      log("回复(" + as + "身份)失败：" + r.detail.slice(0, 160));
    }
    return false;
  }

  async function refreshRoster() {
    // 名册：user 身份优先（办公机 bot 身份缺 im:chat scope，实测 99991672），bot 兜底
    const args = ["im", "+chat-members-list", "--chat-id", config.chat_id, "--page-all", "--format", "json"];
    let r = null, used = "user";
    for (const as of ["user", "bot"]) {
      r = await larkRun([...args, "--as", as]);
      if (r.ok) { used = as; break; }
    }
    sweepReceipts();   // 与名册同周期顺带清扫过期收据（空闲舰队不留垃圾台账）
    if (!r?.ok) { log("名册拉取失败（保留旧名册）：" + String(r?.detail || "").slice(0, 200)); return { ok: false }; }
    const j = extractJson(r.stdout);
    if (!j?.data) { log("名册解析失败：非预期 JSON"); return { ok: false }; }
    const old = st.roster || {};
    const oldAlias = new Map((old.members || []).map((m) => [m.open_id, m.aliases || []]));
    const members = [];
    for (const b of j.data.bots || []) members.push({ open_id: b.member_id, name: b.name, type: "bot", app_id: b.app_id || "", aliases: oldAlias.get(b.member_id) || [] });
    for (const u of j.data.users || []) members.push({ open_id: u.member_id, name: u.name, type: "user", app_id: "", aliases: oldAlias.get(u.member_id) || [] });
    st.roster = { updated_at: Date.now(), identity: used, chat_id: config.chat_id, chat_name: (old.chat_id === config.chat_id ? old.chat_name : "") || "", members, truncations: j.data.truncations || [] };
    try { writeFileSync(rosterFile, JSON.stringify(st.roster, null, 2), "utf8"); } catch {}
    log("名册已更新（" + used + " 身份）：bot " + (j.data.bot_total ?? members.filter((m) => m.type === "bot").length) + " / user " + (j.data.user_total ?? members.filter((m) => m.type === "user").length));
    return { ok: true, roster: st.roster };
  }

  function handleCommand(cmd, messageId) {
    st.queue = st.queue.then(async () => {
      if (cmd === "/new" || cmd === "/reset") {
        if (fixedSession()) { await replyText(messageId, "⚠️ 本机已配置固定会话 session_id=" + fixedSession() + "，/new 不生效（要改请改插件配置）。"); return; }
        const old = state.sessionId;
        state.sessionId = null; state.cwd = null; saveState();
        await replyText(messageId, "✅ 已重置会话" + (old ? "（旧会话 " + old + "）" : "") + "，下个任务将开新会话。");
      } else if (cmd === "/status") {
        await replyText(messageId, statusText());
      } else if (cmd === "/roster") {
        const ro = st.roster;
        if (!ro) { await replyText(messageId, "⚠️ 名册为空（拉取失败或未开始），稍后再试 /roster。"); return; }
        const lines = (ro.members || []).map((m) => "- " + m.name + " [" + m.type + "] " + m.open_id + (m.aliases?.length ? " 别名:" + m.aliases.join(",") : ""));
        await replyText(messageId, "📇 群名册（" + new Date(ro.updated_at).toLocaleString("sv-SE") + "，" + (ro.members || []).length + " 员）：\n" + lines.join("\n"));
      } else if (cmd === "/resume") {
        const rs = st.resume;
        if (!rs) { await replyText(messageId, "⚠️ 没有可续作的任务（只有超时未完成且没产出答案的任务会被记录）。"); return; }
        st.resume = null; try { writeFileSync(resumeFile, "null", "utf8"); } catch {}
        await replyText(messageId, "▶️ 续作上次超时任务（同一会话继续，已完成部分在上下文里）：" + String(rs.task).slice(0, 80));
        runTask(rs.task, rs.messageId, rs.pass);
      }
    });
  }

  function runTask(task, messageId, pass) {
    st.queue = st.queue.then(async () => {
      const tag = String(messageId).replace("om_", "");
      try {
        writeFileSync(join(dir, "inbox", tag + ".json"), JSON.stringify({ task, pass, at: Date.now() }), "utf8");
      } catch {}
      st.lastTaskAt = Date.now();
      await replyText(messageId, "✅ 已收到，" + (config.device_name || "agent") + " 开始处理（最长 " + (config.task_timeout_sec || 300) + "s）…");
      if (!dshEntry) {
        await replyText(messageId, "⚠️ dsh 入口未找到（请在插件配置里填 dsh_entry），任务未执行。");
        return;
      }
      const session = fixedSession() || state.sessionId;
      // v1.3：headless_profile 仅显式指定且非默认时才传 --profile（全局位=命令路径前——实测放参数尾会 exit 1）。
      // 零配置行为与 v1.0-v1.2 已验证形态完全一致：dsh headless 自带 headless profile 物化。
      const prof = String(config.headless_profile || "").trim();
      const baseArgs = (prof && prof !== "headless") ? [dshEntry, "--profile", prof, "headless", "--json"] : [dshEntry, "headless", "--json"];
      const envFile = loadEnvFile(config, dir);   // 每任务重读，key 轮换即生效
      const env = decorateNodeEnv({ ...process.env, ...envFile.vars });
      delete env.HERMES_HOME; delete env.OPENCLAW_HOME;
      if (!envFile.file) log("⚠️ 未找到 headless 环境文件（headless_env_file / 运行目录.env / ~/feishu-fleet/.env 均无），模型 key 将只用宿主环境");
      // v1.3 工作目录解析链：显式配置 > 绑定会话的已记录目录 > 宿主环境变量 > 家目录。
      // REG-03 实测：dsh headless 对 --session-id 强制目录一致（"recorded in X not Y" 直接拒）——
      // 老会话续接必须用其记录目录；错误文本自带该路径，runOnce 捕获后自学重试并持久化（一次自愈）。
      const resolveWorkspace = () => String(config.headless_workspace || state.cwd || process.env.DSH_WORKSPACE || os.homedir());

      function runOnce(cwdUsed, isRetry) {
        const args = baseArgs.slice();
        if (session) args.push("--session-id", session);
        args.push(task);
        return new Promise((finish) => {
          const child = spawn(node, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, cwd: cwdUsed, env });
          let answer = null, runErr = null, newSid = null, out = "", timedOut = false;
          const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, (config.task_timeout_sec || 300) * 1000);
          readline.createInterface({ input: child.stdout }).on("line", (line) => {
            out += line + "\n";
            let evt; try { evt = JSON.parse(line); } catch { return; }
            if (evt.type === "session" && evt.sessionId) newSid = evt.sessionId;
            else if (evt.type === "final") { answer = evt.text || ""; if (evt.reason?.kind === "error") runErr = evt.reason?.error?.message || "headless 报错"; }
            else if (evt.type === "error") runErr = evt.error || evt.message || String(evt);
          });
          child.stderr.on("data", (d) => { if (!runErr) runErr = String(d).slice(0, 300); });
          child.on("close", async (code) => {
            clearTimeout(timer);
            if (timedOut) runErr = runErr || "任务超时（>" + (config.task_timeout_sec || 300) + "s），已终止";
            else if (code !== 0 && !runErr) runErr = "dsh headless 退出码 " + code + (out ? "" : "（无输出。若任务含 | 字符且走 cmd 会这样；本插件直调 node 不应有此问题）");
            const m = runErr ? String(runErr).match(/recorded in "([^"]+)"/) : null;
            if (m && !isRetry && m[1] !== cwdUsed) {
              log("会话目录自愈：" + cwdUsed + " → " + m[1]);
              state.cwd = m[1]; saveState();
              finish(await runOnce(m[1], true));
              return;
            }
            if (!fixedSession() && newSid && (newSid !== state.sessionId || !state.cwd)) { state.sessionId = newSid; state.cwd = cwdUsed; saveState(); log("会话绑定：" + newSid + " @" + cwdUsed); }
            finish({ answer, runErr, timedOut });
          });
          child.on("error", (e) => { clearTimeout(timer); finish({ answer: null, runErr: String(e), timedOut: false }); });
        });
      }
      const res = await runOnce(resolveWorkspace(), false);
      const answer = res.answer, runErr = res.runErr, timedOut = res.timedOut;
      // v1.2 断点续作：超时且无最终答案 → 记台账，群内 /resume 沿同一会话继续
      if (timedOut && !answer) {
        st.resume = { task, pass, messageId, at: Date.now() };
        try { writeFileSync(resumeFile, JSON.stringify(st.resume), "utf8"); } catch {}
        log("断点已记录（/resume 可续）：" + String(task).slice(0, 60));
      }
      try { writeFileSync(join(dir, "outbox", tag + ".done.json"), JSON.stringify({ task, pass, answer, runErr, at: Date.now() }), "utf8"); } catch {}
      if (runErr && (answer === null || answer === "")) await replyText(messageId, "⚠️ 任务失败：" + runErr + (timedOut ? "（可发 /resume 续跑）" : ""));
      else if (!answer) await replyText(messageId, "⚠️ 任务完成但无回答" + (runErr ? "：" + runErr : ""));
      else await replyText(messageId, "🔗 结果：\n" + answer);
    });
  }

  async function startConsume() {
    if (st.stopped) return;
    if (!larkEntry) { log("❌ 未找到 lark-cli 的 js 入口（@larksuite/cli/scripts/run.js）。请在插件配置里填 lark_entry，桥未启动。"); return; }
    await killStrayWorkers();   // 启动前清孤儿 worker（防同一事件被多 worker 重复消费）
    if (st.stopped) return;
    const child = spawnLark(["event", "consume", "im.message.receive_v1", "--as", "bot"], { stdinHold: true }); // 坑3：stdin 保持打开
    st.child = child;
    st.running = true;
    log("飞书事件长连接已启动（pid=" + child.pid + "，chat=" + config.chat_id + "）");
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let evt; try { evt = JSON.parse(line); } catch { return; }   // [event] 等非 JSON 日志行直接跳过
      if (evt.type !== "im.message.receive_v1") return;
      st.lastEventAt = Date.now();
      // v1.2 回执注回：对"本机发出的被跟踪消息"的线程回复 → 注回发起会话（不走路由、不当指令）
      const rec = findReceipt(evt, st.receipts);
      if (rec) {
        if (!isFinalReceipt(evt.content)) {
          log("对端过程回执（不注回，等终态） " + String(rec.messageId).slice(0, 14));
          return;
        }
        log("收到对端终态回执 " + String(rec.messageId).slice(0, 14) + "… → 注回会话 " + rec.sessionId.slice(0, 22));
        st.queue = st.queue.then(async () => {
          try {
            const text = "【飞书回执|task=" + (rec.taskId || rec.messageId) + "】" + cleanReceiptBody(evt.content);
            if (typeof hooks.injectReceipt === "function") await hooks.injectReceipt({ sessionId: rec.sessionId, text, requestId: "fleet-receipt-" + rec.messageId });
            st.receipts = st.receipts.filter((x) => x !== rec); saveReceipts();
            log("回执注回成功 " + rec.sessionId.slice(0, 22));
          } catch (e) { log("回执注回失败：" + String(e).slice(0, 160)); }
        });
        return;
      }
      const r = routeEvent(evt, {
        chat_id: config.chat_id, bot_open_id: config.bot_open_id,
        max_depth: Number(config.task_max_depth) || 3,
      }, seenTaskIds);
      if (!r.accept) {
        // 坑6：拦截回复一律走 replyText（[bot-reply] 前缀）；task-visited 静默丢，防回复风暴
        if (evt.message_id && (r.reason === "bot-no-task-pass" || r.reason === "depth-exceeded") && config.reply_reject !== false) {
          log("路条拦截（" + r.reason + "）" + String(evt.message_id).slice(0, 14));
          const why = r.reason === "bot-no-task-pass"
            ? "格式无效：agent 派活必须带路条 [任务ID|发起人|派发深度N]"
            : "路条深度超限（" + r.pass?.depth + " > " + (Number(config.task_max_depth) || 3) + "），已拒绝，请升级给人处理";
          st.queue = st.queue.then(() => replyText(evt.message_id, "⚠️ " + why));
        }
        return;
      }
      if (r.cmd) {
        log("收到指令 " + r.cmd + "（" + String(evt.message_id).slice(0, 14) + "…）");
        handleCommand(r.cmd, evt.message_id);
        return;
      }
      if (r.pass) {
        markDone(r.pass.taskId, r.pass.from);
        log("收到任务（路条 " + r.pass.taskId + " ← " + r.pass.from + " 深度" + r.pass.depth + "）: " + r.task.slice(0, 60));
      } else {
        log("收到任务 " + String(evt.message_id).slice(0, 14) + "…: " + r.task.slice(0, 80));
      }
      runTask(r.task, evt.message_id, r.pass);
    });
    child.stderr.on("data", (d) => log("consume stderr: " + String(d).slice(0, 200)));
    child.on("close", (code) => {
      st.running = false; st.child = null;
      if (st.stopped) return;
      // run.js 是"fork worker 后父进程退出"形态：父进程退出 ≠ worker 死，先查再决定重启
      setTimeout(async () => {
        if (st.stopped) return;
        const live = await psListWorkers();
        if (live.length > 0) { log("consume 父进程退出但 worker 存活(pid=" + live.join(",") + ")，不重启"); return; }
        const wait = RESTART_BACKOFF_MS[Math.min(st.restartIdx++, RESTART_BACKOFF_MS.length - 1)];
        log("consume 真退出（exit " + code + "），" + Math.round(wait / 1000) + "s 后重启（第 " + st.restartIdx + " 次）");
        st.restartTimer = setTimeout(startConsume, wait);
      }, 8000);
    });
  }

  function statusText() {
    const s = {
      running: st.running,
      deviceName: config.device_name, chatId: config.chat_id, botOpenId: config.bot_open_id,
      lastEventAt: st.lastEventAt, lastTaskAt: st.lastTaskAt,
    };
    const session = fixedSession() || state.sessionId;
    const lines = [
      "运行中: " + (s.running ? "是（监听群 " + s.chatId + "）" : "否"),
      "设备名: " + s.deviceName + "    bot: " + s.botOpenId,
      "lark入口: " + (larkEntry || "未找到") + "    dsh入口: " + (dshEntry || "未找到"),
      "会话: " + (session ? session + (fixedSession() ? "（配置固定）" : "（自动绑定）") : "未绑定（首任务后建立）"),
      "路条: 深度≤" + (Number(config.task_max_depth) || 3) + "，本机已接任务 " + doneTasks.length + " 条",
      "回执: 待收 " + liveReceipts().length + " 条" + (typeof hooks.injectReceipt === "function" ? "（注回会话可用）" : "（本 profile 无 sessionController，仅群内可见）"),
      "续作: " + (st.resume ? "有（/resume 续跑上次超时任务）" : "无"),
      "名册: " + (st.roster ? (st.roster.members || []).length + " 员（" + new Date(st.roster.updated_at).toLocaleString("sv-SE") + "，" + st.roster.identity + " 身份）" : "未拉取"),
      "最近事件: " + (s.lastEventAt ? new Date(s.lastEventAt).toLocaleString() : "无"),
      "最近任务: " + (s.lastTaskAt ? new Date(s.lastTaskAt).toLocaleString() : "无"),
    ];
    try {
      const logText = readFileSync(join(dir, "logs", "bridge.log"), "utf8").split("\n").filter(Boolean);
      lines.push("--- 日志末 12 行 ---");
      lines.push(...logText.slice(-12));
    } catch {}
    return lines.join("\n");
  }

  return {
    get status() {
      return {
        running: st.running,
        larkEntry, dshEntry,
        deviceName: config.device_name, chatId: config.chat_id, botOpenId: config.bot_open_id,
        lastEventAt: st.lastEventAt, lastTaskAt: st.lastTaskAt,
        sessionId: fixedSession() || state.sessionId,
        fixedSession: !!fixedSession(),
        roster: st.roster,
        doneTasks: doneTasks.length,
        queued: st.queue === Promise.resolve() ? 0 : 1,
      };
    },
    statusText,
    getRoster: () => st.roster,
    refreshRoster,
    start() {
      const okCfg = config.chat_id && config.bot_open_id && config.device_name;
      if (!okCfg) { log("配置不完整（device_name / chat_id / bot_open_id），桥未启动。请在插件配置里填写。"); return; }
      startConsume();
      st.queue = st.queue.then(() => refreshRoster().catch((e) => log("名册刷新异常：" + e)));
    },
    async send({ text, mentionOpenId, mentionName, chatId, identity, ownerSessionId }) {
      // fleet_send 执行体：text + <at user_id>（纯文本）。v1.2：身份=config.send_identity/本次 override
      // 笔记本 迁移完成前默认 user（旧桥只认 user），全舰队升齐后配置切 bot（身份归位第二步）
      const to = chatId || config.chat_id;
      const dev = config.device_name || "agent";
      const as = identity || config.send_identity || "bot";
      let target = mentionOpenId || null;
      if (!target && mentionName && st.roster) {
        const q = String(mentionName).toLowerCase();
        const hit = (st.roster.members || []).find((m) => m.name === mentionName || String(m.name).toLowerCase().includes(q) || (m.aliases || []).some((a) => a.toLowerCase().includes(q)));
        if (hit) target = hit.open_id; else return { ok: false, content: "名册里找不到 \"" + mentionName + "\"，可用 fleet_roster 查看成员。" };
      }
      let body = "[" + dev + "] " + text;
      if (target) body = '<at user_id="' + target + '"></at> ' + body;
      const r = await larkRun(["im", "+messages-send", "--chat-id", to, "--text", "-", "--as", as,
        "--idempotency-key", "fleet-" + Date.now()], 60_000, body);
      if (!r.ok) return { ok: false, content: "发送失败：" + r.detail.slice(0, 200) };
      let messageId = null; try { messageId = JSON.parse(r.stdout).data?.message_id || null; } catch {}
      // v1.2 回执注回：定向派活（@ 了目标）且有发起会话才登记收据；群公告不登记（v1.3）
      const tracked = !!(messageId && shouldTrackReceipt({ target, ownerSessionId }));
      if (tracked) {
        const pass = parseTaskPass(body);
        st.receipts.push({
          messageId, sessionId: String(ownerSessionId),
          task: String(text).slice(0, 200), taskId: pass?.taskId || null,
          at: Date.now(), expires: Date.now() + (Number(config.receipt_window_min) || 45) * 60_000,
        });
        saveReceipts();
        log("收据登记 " + messageId.slice(0, 14) + "… → 会话 " + String(ownerSessionId).slice(0, 22) + "（窗口 " + (Number(config.receipt_window_min) || 45) + " 分钟）");
      }
      const who = target ? "，已@" + (mentionName || target) : "";
      return { ok: true, content: "已发送（" + as + " 身份，署名 [" + dev + "]" + who + "）message_id=" + (messageId || "?") + " chat=" + to + (tracked ? "；对端回执将自动注回本会话" : "") };
    },
    stop() {
      st.stopped = true;
      if (st.restartTimer) { clearTimeout(st.restartTimer); st.restartTimer = null; }
      if (st.child) { try { st.child.kill(); } catch {} st.child = null; }
      st.running = false;
    },
  };
}

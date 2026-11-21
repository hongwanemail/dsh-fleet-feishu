// fleet-feishu 装机冒烟自测（开源用户排障第一步，零依赖只读检查）
// 用法：node test/smoke.mjs [选项]
//   --chat oc_xxx        同时校验名册可达（建议）
//   --bot ou_xxx         配合 --chat：校验该 bot open_id 确实在群里（配置错最常见来源）
//   --device 名字        配合 --chat：按名字在名册里找（比 --bot 直观，模糊匹配）
// 结果：每行 [PASS|WARN|FAIL]；FAIL=环境不满足插件运行，按提示去 docs/USAGE.md；exit code 反映。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolveEntry, runtimeDir, parseTaskPass } from "../bridge.js";

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const chat = opt("--chat"), bot = opt("--bot"), device = opt("--device");
let fails = 0, warns = 0;
const say = (lvl, msg, hint) => {
  if (lvl === "FAIL") fails++; else if (lvl === "WARN") warns++;
  console.log("[" + lvl + "] " + msg + (hint && lvl !== "PASS" ? "\n       ↳ " + hint : ""));
};

// 1) Node 版本
const nv = Number(process.versions.node.split(".")[0]);
nv >= 18 && Number(process.versions.node.split(".")[1]) >= 17 || process.versions.node.startsWith("2")
  ? say("PASS", "Node " + process.version)
  : (nv >= 18 ? say("PASS", "Node " + process.version) : say("FAIL", "Node " + process.version + " < 18.17", "升级 Node（dsh/lark-cli 的最低要求）"));

// 2) lark-cli 入口探测
const lark = resolveEntry({}, "lark");
lark ? say("PASS", "lark 入口: " + lark) : say("FAIL", "lark-cli 入口未找到", "npm i -g @larksuite/cli；或插件配置 lark_entry 指到 run.js/lark-cli.exe");

// 3) dsh 入口探测
const dsh = resolveEntry({}, "dsh");
dsh ? say("PASS", "dsh 入口: " + dsh) : say("FAIL", "dsh CLI 未找到", "npm i -g @deepseek-ai/dsh；或配置 dsh_entry");

// 4) 运行目录可写
try {
  const dir = runtimeDir(); mkdirSync(dir, { recursive: true });
  const p = dir + "\\smoke.tmp"; if (process.platform === "win32") { writeFileSync(p, "x"); unlinkSync(p); }
  else { const j = (await import("node:path")).join; const q = j(dir, "smoke.tmp"); writeFileSync(q, "x"); unlinkSync(q); }
  say("PASS", "运行目录可写: " + dir);
} catch (e) { say("FAIL", "运行目录不可写: " + e.message); }

// 5) lark 身份状态（不打印任何敏感值）
if (lark) {
  const env = { ...process.env }; delete env.HERMES_HOME; delete env.OPENCLAW_HOME;
  const isJs = /\.js$/i.test(lark);
  const r = spawnSync(isJs ? process.execPath : lark, isJs ? [lark, "auth", "status"] : ["auth", "status"], { encoding: "utf8", env, windowsHide: true, timeout: 30_000 });
  let j = null; try { j = JSON.parse(r.stdout.slice((r.stdout || "").indexOf("{"))); } catch {}
  if (!j) say("FAIL", "lark auth status 无法解析", "先手动跑一次 lark-cli auth status 看输出");
  else {
    const botOk = j.identities?.bot?.available, usr = j.identities?.user || {};
    botOk ? say("PASS", "bot 身份 ready（app " + (j.appId || "?") + "）") : say("FAIL", "bot 身份不可用", "lark-cli 需绑定本设备自己的应用（USAGE §2.8）");
    usr.available ? say("PASS", "user 身份 ready（回执/名册兜底可用）") : say("WARN", "user 身份未授权（可用 bot 身份运行，但名册与部分回执走兜底）", "推荐：lark-cli auth login 扫码，scope 含 im:message.send_as_user");
    // 6) 名册联通 + bot_open_id 校验
    if (botOk && chat) {
      const a = spawnSync(isJs ? process.execPath : lark, isJs
        ? [lark, "im", "+chat-members-list", "--chat-id", chat, "--page-all", "--format", "json", "--as", "bot"]
        : ["im", "+chat-members-list", "--chat-id", chat, "--page-all", "--format", "json", "--as", "bot"], { encoding: "utf8", env, windowsHide: true, timeout: 60_000 });
      let m = null; try { m = JSON.parse(a.stdout.slice((a.stdout || "").indexOf("{"))); } catch {}
      if (!m?.ok) {
        const a2 = spawnSync(isJs ? process.execPath : lark, (isJs ? [lark] : []).concat(["im", "+chat-members-list", "--chat-id", chat, "--page-all", "--format", "json", "--as", "user"]), { encoding: "utf8", env, windowsHide: true, timeout: 60_000 });
        try { m = JSON.parse(a2.stdout.slice((a2.stdout || "").indexOf("{"))); } catch {}
      }
      if (!m?.ok) say("WARN", "名册拉取失败：" + String(m?.error?.message || "").slice(0, 80), "多半是 im:chat scope 未申请且 user 未授权（不影响接单，影响 --bot/--device 校验）");
      else {
        const members = (m.data?.bots || []).concat(m.data?.users || []);
        say("PASS", "名册可达（群 " + chat + " 共 " + members.length + " 员）");
        const want = bot || (device && members.find((x) => String(x.name).includes(device))?.member_id);
        if (bot || device) {
          if (!want || !members.some((x) => x.member_id === want)) say("FAIL", (bot ? "指定 bot " + bot : "设备 \"" + device + "\"") + " 不在群名册里", "open_id 以【本应用视角】为准——用本设备 lark 查/或 fleet_roster；这是装机错误第一名");
          else say("PASS", "目标成员在群内 ✓");
        }
      }
    } else if (botOk) say("WARN", "未传 --chat：跳过名册联通校验（建议跑：node test/smoke.mjs --chat oc_你的群ID --device 某bot名）");
  }
}

// 7) 协议解析自检（路条文法冒烟）
const t = parseTaskPass("[任务ID|SMOKE-1|本机|派发深度1] hi");
t && t.taskId === "SMOKE-1" && t.depth === 1 ? say("PASS", "路条解析自检 ✓") : say("FAIL", "路条解析异常（代码问题，请报 issue）");

console.log("\n== 冒烟结论: " + (fails ? "FAIL " + fails + " 项" : "PASS" + (warns ? "（" + warns + " 个 WARN 可选处理）" : "")));
process.exit(fails ? 1 : 0);

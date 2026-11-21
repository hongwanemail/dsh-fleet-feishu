// presence.js —— MQTT 风格在线感知（心跳表载体）
//
// 背景与设计：docs/OPTIMIZATION.md §1-§3（宏万 2026-11-18 拍板：lark-base 多维表格 = 唯一主线；
// 真 MQTT broker 已否决——NAS 无公网 IP，虚拟组网已排除）。
//
// 语义对齐 MQTT：
//   Retained 状态消息  → 本机每次心跳都覆盖同一行（表本身就是"当前状态快照"）
//   LWT + keepalive 超时 → 离线【不是宣布出来的，是 TTL 判出来的】：崩溃/断电没机会道别，
//                          由读取方按 last_seen + TTL 判离线；正常退出时主动写 offline 加速收敛
//   Subscribe before publish → fleet_send 派活前先查表，离线立即回报发起方，不静默等死
//
// 载体：飞书多维表格（一行 = 一台设备）
//   列：设备 | app_id | 别名 | last_seen | 最后任务 | 版本 | 状态
//   **app_id 是全局唯一且视角无关的键**——open_id 会随"谁在看"变（见 docs/飞书消息发送强制规范.md），
//   用 app_id 做匹配键才能跨设备正确对上。
//
// 依赖：全部走 lark-cli（不引入新 npm 依赖）
//   写：base +record-upsert（带 --record-id 则更新，否则新建；本机 record_id 缓存在 state）
//   读：base +record-list --format json（内联矩阵，无需落临时文件）
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PRESENCE_FIELDS = ["设备", "app_id", "别名", "last_seen", "最后任务", "版本", "状态"];

export function createPresence({ config, log, larkRun, workDir }) {
  const baseToken = () => String(config.presence_base_token || "").trim();
  const tableId = () => String(config.presence_table_id || "").trim();
  const enabled = () => !!(baseToken() && tableId());
  const ttlMs = () => (Number(config.presence_ttl_sec) || 90) * 1000;
  const intervalMs = () => (Number(config.presence_interval_sec) || 60) * 1000;

  function nowIso() {
    return new Date().toISOString();
  }

  // ---- 读：列出全部设备心跳 ----
  async function list() {
    if (!enabled()) return [];
    const args = [
      "base", "+record-list",
      "--base-token", baseToken(),
      "--table-id", tableId(),
      "--format", "json",
      "--limit", "200",
      "--as", "user",
    ];
    const r = await larkRun(args, 30000, null, workDir);
    if (!r.ok) {
      log("presence: 读心跳表失败：" + String(r.detail || "").slice(0, 160));
      return [];
    }
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 非 JSON → 忽略 */ }
    const data = j?.data?.data;
    const fields = j?.data?.fields;
    if (!Array.isArray(data) || !Array.isArray(fields)) return [];
    const rows = [];
    for (const arr of data) {
      const row = {};
      fields.forEach((name, i) => { row[name] = arr[i] ?? ""; });
      rows.push({
        device: String(row["设备"] || ""),
        appId: String(row["app_id"] || ""),
        alias: String(row["别名"] || ""),
        lastSeen: String(row["last_seen"] || ""),
        task: String(row["最后任务"] || ""),
        version: String(row["版本"] || ""),
        status: String(row["状态"] || ""),
      });
    }
    return rows;
  }

  // ---- 判在线：TTL 超时即离线（不由设备自己宣布）----
  function judgeOnline(row, now = Date.now()) {
    if (!row) return false;
    if (row.status === "offline") return false;
    const ms = Date.parse(row.lastSeen);
    if (!Number.isFinite(ms)) return false;
    return now - ms <= ttlMs();
  }

  // ---- 查某台设备 ----
  // 匹配键优先级：app_id（全局唯一、视角无关）→ 设备名 → 别名
  async function lookup({ appId, name } = {}) {
    const rows = await list();
    const now = Date.now();
    for (const row of rows) {
      const hit = (appId && row.appId && row.appId === appId)
        || (name && row.device === name)
        || (name && row.alias === name);
      if (hit) {
        return { ...row, online: judgeOnline(row, now), lastSeenMs: Date.parse(row.lastSeen) };
      }
    }
    return null;
  }

  // ---- 写心跳（upsert：本机 record_id 缓存在调用方）----
  async function write({ status = "online", taskId = "", appId = "", alias = "", recordId = "" } = {}) {
    if (!enabled()) return { ok: false, reason: "presence-disabled" };
    const fields = {
      "设备": config.device_name || "agent",
      "app_id": appId || "",
      "别名": alias || "",
      "last_seen": nowIso(),
      "最后任务": taskId || "(none)",
      "版本": config.presence_version || "",
      "状态": status,
    };
    // lark-cli 的 @file 白名单只认 cwd / 账户 temp / ~/files —— 用 workDir 当 cwd + 相对文件名
    const rel = `presence_write_${process.pid}_${Date.now()}.json`;
    const abs = join(workDir, rel);
    try { writeFileSync(abs, JSON.stringify(fields), "utf8"); } catch (e) {
      log("presence: 写临时文件失败：" + String(e).slice(0, 120));
      return { ok: false, reason: "write-file-failed" };
    }
    try {
      const args = ["base", "+record-upsert", "--base-token", baseToken(), "--table-id", tableId()];
      if (recordId) args.push("--record-id", recordId);
      args.push("--json", "@" + rel, "--as", "user");
      const r = await larkRun(args, 30000, null, workDir);
      if (!r.ok) {
        log("presence: 写心跳失败：" + String(r.detail || "").slice(0, 160));
        return { ok: false, reason: "upsert-failed" };
      }
      let rid = recordId || "";
      try {
        const list0 = JSON.parse(r.stdout)?.data?.record?.record_id_list;
        if (Array.isArray(list0) && list0[0]) rid = list0[0];
      } catch { /* 解析失败则沿用旧 id */ }
      return { ok: true, recordId: rid, fields };
    } finally {
      try { unlinkSync(abs); } catch { /* 清理失败无所谓 */ }
    }
  }

  // ---- 找本机已有行（拿 record_id，用于后续更新而不是重复建行）----
  async function findSelfRow(appId, deviceName) {
    const rows = await list();
    for (const row of rows) {
      if ((appId && row.appId && row.appId === appId) || (deviceName && row.device === deviceName)) {
        return row;
      }
    }
    return null;
  }

  // 清理工作目录里遗留的临时文件（异常退出可能留下）
  function sweepTemp() {
    try {
      for (const n of readdirSync(workDir)) {
        if (n.startsWith("presence_write_") && n.endsWith(".json")) {
          try { unlinkSync(join(workDir, n)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  return {
    enabled,
    ttlMs,
    intervalMs,
    list,
    lookup,
    judgeOnline,
    write,
    findSelfRow,
    sweepTemp,
    status() {
      return {
        enabled: enabled(),
        baseToken: baseToken() ? baseToken().slice(0, 6) + "…" : "",
        tableId: tableId(),
        ttlSec: Math.round(ttlMs() / 1000),
        intervalSec: Math.round(intervalMs() / 1000),
      };
    },
  };
}

// fleet-feishu v1.1 路由闸单元测试（无外部依赖：node test/route.test.mjs）
// 覆盖：路条硬闸（bot 无路条拒收/深度超限/同任务回环）、reply 继承闸、回执前缀闸、
//       群内指令识别（仅 user 且无路条）、mention/群/消息类型过滤。
import assert from "node:assert/strict";
import { routeEvent, parseTaskPass, findReceipt, isBotReply, isFinalReceipt, shouldTrackReceipt } from "../bridge.js";

const CFG = { chat_id: "oc_test", bot_open_id: "ou_bot_self", max_depth: 3 };
const M = (id) => [{ id, key: "@_user_1", name: "小鲸鱼-测试" }];

function evt(over = {}) {
  return {
    chat_type: "group", chat_id: CFG.chat_id, message_type: "text",
    sender_type: "user", sender_id: "ou_boss", mentions: M(CFG.bot_open_id),
    message_id: "om_x1", content: "@小鲸鱼-测试 查一下C盘空间",
    ...over,
  };
}

let n = 0;
const t = (name, fn) => { n++; try { fn(); console.log("ok  " + name); } catch (e) { console.error("FAIL " + name + " :: " + e.message); process.exitCode = 1; } };

// —— 基本 user 流（v1.0 行为不变）——
t("user 普通任务 -> accept", () => {
  const r = routeEvent(evt(), CFG);
  assert.equal(r.accept, true); assert.equal(r.cmd, null); assert.equal(r.pass, null);
  assert.equal(r.task, "查一下C盘空间");
});
t("user /new -> 指令", () => {
  const r = routeEvent(evt({ content: "@小鲸鱼-测试 /new" }), CFG);
  assert.equal(r.accept, true); assert.equal(r.cmd, "/new");
});
t("user /status 带后续词也算指令", () => {
  const r = routeEvent(evt({ content: "@小鲸鱼-测试 /status 现在" }), CFG);
  assert.equal(r.cmd, "/status");
});
t("user 带路条的新任务 -> accept + pass 解析", () => {
  const r = routeEvent(evt({ content: "@小鲸鱼-测试 [任务ID|WIKI-20261114-01|笔记本|派发深度1] 接入llmwiki" }), CFG);
  assert.equal(r.accept, true);
  assert.deepEqual(r.pass, { taskId: "WIKI-20261114-01", from: "笔记本", depth: 1 });
});

// —— v1.1 bot→agent 路条硬闸 ——
t("bot 无路条 -> 拒收 bot-no-task-pass", () => {
  const r = routeEvent(evt({ sender_type: "bot", sender_id: "ou_mac_bot", content: "@小鲸鱼-测试 帮我查磁盘" }), CFG);
  assert.equal(r.accept, false); assert.equal(r.reason, "bot-no-task-pass");
});
t("bot 带路条 depth1 -> accept", () => {
  const r = routeEvent(evt({ sender_type: "bot", sender_id: "ou_mac_bot", content: "@小鲸鱼-测试 [任务ID|T-9|笔记本|派发深度1] 查磁盘" }), CFG);
  assert.equal(r.accept, true); assert.equal(r.pass.depth, 1);
});
t("bot 带路条 depth3（=上限）-> accept", () => {
  const r = routeEvent(evt({ sender_type: "bot", sender_id: "ou_mac_bot", content: "[任务ID|T-10|X|派发深度3] 活" }), CFG);
  assert.equal(r.accept, true);
});
t("bot 带路条 depth4 -> 拒收 depth-exceeded", () => {
  const r = routeEvent(evt({ sender_type: "bot", sender_id: "ou_mac_bot", content: "[任务ID|T-11|X|派发深度4] 活" }), CFG);
  assert.equal(r.accept, false); assert.equal(r.reason, "depth-exceeded"); assert.equal(r.pass.taskId, "T-11");
});
t("同任务ID回环（seen）-> 拒收 task-visited", () => {
  const seen = new Set(["T-12"]);
  const r = routeEvent(evt({ content: "[任务ID|T-12|办公机|派发深度1] 别再绕回来" }), CFG, seen);
  assert.equal(r.accept, false); assert.equal(r.reason, "task-visited");
});
t("user 带 depth9 路条也拦（统一硬闸）", () => {
  const r = routeEvent(evt({ content: "[任务ID|T-13|X|派发深度9] 活" }), CFG);
  assert.equal(r.accept, false); assert.equal(r.reason, "depth-exceeded");
});

// —— v1.0 固化的防循环闸不回归 ——
t("reply_to 顶层闸", () => {
  const r = routeEvent(evt({ reply_to: "om_000" }), CFG);
  assert.equal(r.accept, false); assert.equal(r.reason, "reply-not-command");
});
t("[bot-reply] 前缀闸", () => {
  const r = routeEvent(evt({ content: "[bot-reply] ✅ 已收到" }), CFG);
  assert.equal(r.accept, false); assert.equal(r.reason, "bot-reply");
});
t("本 bot 自己的 bot 消息 -> self", () => {
  const r = routeEvent(evt({ sender_type: "bot", sender_id: CFG.bot_open_id, content: "[任务ID|T-14|Self|派发深度1] 活" }), CFG);
  assert.equal(r.accept, false); assert.equal(r.reason, "self");
});

// —— 过滤条件 ——
t("未 @ 本 bot -> no-mention", () => {
  const r = routeEvent(evt({ mentions: [{ id: "ou_other" }] }), CFG);
  assert.equal(r.accept, false); assert.equal(r.reason, "no-mention");
});
t("别的群 -> other-chat", () => {
  const r = routeEvent(evt({ chat_id: "oc_else" }), CFG);
  assert.equal(r.accept, false); assert.equal(r.reason, "other-chat");
});
t("post 富文本 -> not-text", () => {
  const r = routeEvent(evt({ message_type: "post" }), CFG);
  assert.equal(r.accept, false); assert.equal(r.reason, "not-text");
});
t("bot 无路条时 /status 也不放行（指令仅 user）", () => {
  const r = routeEvent(evt({ sender_type: "bot", sender_id: "ou_mac_bot", content: "/status" }), CFG);
  assert.equal(r.accept, false); assert.equal(r.reason, "bot-no-task-pass");
});
t("bot 带路条发 /new -> 当任务执行不当指令（路条保留在正文，供执行方 +1 转发）", () => {
  const r = routeEvent(evt({ sender_type: "bot", sender_id: "ou_mac_bot", content: "[任务ID|T-15|M|派发深度2] /new" }), CFG);
  assert.equal(r.accept, true); assert.equal(r.cmd, null);
  assert.ok(r.task.includes("/new") && r.task.includes("T-15"), "路条应保留在任务正文: " + r.task);
});

// —— 路条解析容错 ——
t("parseTaskPass 全角竖线+空格", () => {
  const p = parseTaskPass("前文 [任务ID ｜ TASK.2-A ｜ 客户服务器 ｜ 派发深度 2] 后文");
  assert.deepEqual(p, { taskId: "TASK.2-A", from: "客户服务器", depth: 2 });
});
t("parseTaskPass 无路条 -> null", () => {
  assert.equal(parseTaskPass("普通消息没有路条"), null);
});

// —— v1.2 回执注回 findReceipt ——
const RE = [{ messageId: "om_track1", sessionId: "session-lead", taskId: "T-20", expires: Date.now() + 60_000 }];
t("findReceipt 线程回复+前缀+未过期 -> 命中", () => {
  const r = findReceipt({ chat_type: "group", reply_to: "om_track1", content: "[bot-reply] [QingLvServer] 🔗 结果：24.9GB" }, RE);
  assert.equal(r, RE[0]);
});
t("findReceipt 根消息链 root_id 也命中", () => {
  const r = findReceipt({ chat_type: "group", root_id: "om_track1", content: "[bot-reply] ok" }, RE);
  assert.equal(r, RE[0]);
});
t("findReceipt 无 [bot-reply] 前缀 -> 不注回（那是新指令候选）", () => {
  assert.equal(findReceipt({ chat_type: "group", reply_to: "om_track1", content: "顺便问一句别的" }, RE), null);
});
t("findReceipt 过期 -> 不命中", () => {
  const old = [{ ...RE[0], expires: Date.now() - 1 }];
  assert.equal(findReceipt({ chat_type: "group", reply_to: "om_track1", content: "[bot-reply] x" }, old), null);
});
t("findReceipt 非回复的顶层消息 -> 不命中", () => {
  assert.equal(findReceipt({ chat_type: "group", content: "[bot-reply] x" }, RE), null);
});

// —— v1.2 /resume 指令 ——
t("user /resume -> 指令", () => {
  const r = routeEvent(evt({ content: "@小鲸鱼-测试 /resume" }), CFG);
  assert.equal(r.accept, true); assert.equal(r.cmd, "/resume");
});

// —— 边界形态 ——
t("未知 sender_type -> unknown-sender", () => {
  const r = routeEvent(evt({ sender_type: "anonymous" }), CFG);
  assert.equal(r.accept, false); assert.equal(r.reason, "unknown-sender");
});
t("@ 了但正文为空 -> empty", () => {
  const r = routeEvent(evt({ content: "@小鲸鱼-测试   " }), CFG);
  assert.equal(r.accept, false); assert.equal(r.reason, "empty");
});

// —— v1.2 修正回归：真实回执格式是 "[设备名] [bot-reply] …"（署名在前），前缀闸必须容忍 ——
t("[设备名] 前缀的 [bot-reply] 也被前缀闸识别（v1.1 曾空转的真 bug）", () => {
  assert.ok(isBotReply("[QingLvServer] [bot-reply] 🔗 结果： 回执到达"));
  const r = routeEvent(evt({ content: "[QingLvServer] [bot-reply] 顶层版回执（无双闸时会被当指令）" }), CFG);
  assert.equal(r.accept, false); assert.equal(r.reason, "bot-reply");
});
t("findReceipt 匹配真实署名格式回执", () => {
  const r = findReceipt({ chat_type: "group", reply_to: "om_track1", content: "[QingLvServer] [bot-reply] ✅ 已收到" }, RE);
  assert.equal(r, RE[0]);
});
t("isFinalReceipt：过程回执(已收到)不注回，终态(结果/失败)才注回", () => {
  assert.equal(isFinalReceipt("[QingLvServer] [bot-reply] ✅ 已收到，开始处理…"), false);
  assert.equal(isFinalReceipt("[QingLvServer] [bot-reply] 🔗 结果： 注回成功"), true);
  assert.equal(isFinalReceipt("[bot-reply] ⚠️ 任务失败：timeout"), true);
});

// —— v1.3 收据登记门槛：只跟定向派活，不跟群公告 ——
t("shouldTrackReceipt：@目标+有发起会话 才登记", () => {
  assert.equal(shouldTrackReceipt({ target: "ou_x", ownerSessionId: "session-a" }), true);
  assert.equal(shouldTrackReceipt({ target: null, ownerSessionId: "session-a" }), false);  // 群公告
  assert.equal(shouldTrackReceipt({ target: "ou_x", ownerSessionId: null }), false);       // 终端手发
  assert.equal(shouldTrackReceipt({}), false);
});
t("bot /resume（无路条）-> 仍拒（指令仅老板）", () => {
  const r = routeEvent(evt({ sender_type: "bot", sender_id: "ou_other", content: "/resume" }), CFG);
  assert.equal(r.accept, false);
});

console.log(`\n${n} 项断言完成，exitCode=${process.exitCode || 0}`);

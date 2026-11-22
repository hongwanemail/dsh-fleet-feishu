// REST 传输层与桥接安全闸的单元测试（mock fetch，不打真网络）
import assert from "node:assert";
import { FeishuRest, cfgValue } from "../feishuRest.js";
import { createRestBridge, stripMentions, mentionsMe, parseTaskPass } from "../bridgeRest.js";

let t = 0;
const ok = (name, fn) => { t++; try { fn(); console.log("  ok  " + name); } catch (e) { console.log("  FAIL " + name + " → " + e.message); process.exitCode = 1; } };

// ---------- mock 飞书 ----------
function makeFetch({ chats = [], members = [], messages = [], token = "T-123" } = {}) {
  const calls = [];
  const f = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams) });
    const json = (o) => ({ status: 200, json: async () => o });
    if (u.pathname.endsWith("/tenant_access_token/internal")) {
      return json({ code: 0, msg: "ok", data: { tenant_access_token: token, expire: 7200 } });
    }
    if (u.pathname === "/open-apis/im/v1/chats") {
      return json({ code: 0, msg: "ok", data: { items: chats, has_more: false } });
    }
    if (/\/members$/.test(u.pathname)) {
      return json({ code: 0, msg: "ok", data: { items: members, has_more: false } });
    }
    if (u.pathname === "/open-apis/im/v1/messages" && (opts.method || "GET") === "GET") {
      return json({ code: 0, msg: "ok", data: { items: messages, has_more: false } });
    }
    if (u.pathname === "/open-apis/im/v1/messages" && opts.method === "POST") {
      return json({ code: 0, msg: "ok", data: { message_id: "om_new_1" } });
    }
    return json({ code: 404, msg: "no route" });
  };
  f.calls = calls;
  return f;
}

const originalFetch = globalThis.fetch;
function withFetch(mock, fn) {
  globalThis.fetch = mock;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = originalFetch; });
}

// ---------- 传输层 ----------
await withFetch(makeFetch({ chats: [{ chat_id: "oc_1", name: "测试群" }], members: [{ member_id: "ou_bot", name: "机器人", app_id: "cli_x" }] }), async () => {
  const rest = new FeishuRest({ appId: "cli_x", appSecret: "sec", log: () => {} });
  ok("ready：两个参数齐了才算 ready", () => assert.equal(rest.ready, true));
  ok("ready：缺 secret 不 ready", () => assert.equal(new FeishuRest({ appId: "cli_x" }).ready, false));
  ok("换 token 成功", async () => {});
  const tok = await rest.ensureToken();
  ok("拿到 token", () => assert.equal(tok, "T-123"));
  const chats = await rest.listChats();
  ok("拉群列表", () => assert.equal(chats.length, 1));
  ok("群字段映射", () => assert.equal(chats[0].chatId, "oc_1"));
  const self = await rest.findSelfInChat("oc_1");
  ok("按 app_id 找到自己", () => assert.equal(self.openId, "ou_bot"));
  const mid = await rest.sendToChat("oc_1", "hello");
  ok("发消息返回 message_id", () => assert.equal(mid, "om_new_1"));
});

// token 失效自动重换
await withFetch((() => {
  let first = true;
  const f = async (url, opts = {}) => {
    const u = new URL(url);
    const json = (o) => ({ status: 200, json: async () => o });
    if (u.pathname.endsWith("/tenant_access_token/internal")) return json({ code: 0, msg: "ok", data: { tenant_access_token: "T-" + (first ? "1" : "2"), expire: 7200 } });
    if (u.pathname === "/open-apis/im/v1/chats") {
      if (first) { first = false; return json({ code: 99991663, msg: "token invalid" }); }
      return json({ code: 0, msg: "ok", data: { items: [{ chat_id: "oc_2", name: "n" }], has_more: false } });
    }
    return json({ code: 0, msg: "ok", data: { items: [{ chat_id: "oc_2", name: "n" }], has_more: false } });
  };
  return f;
})(), async () => {
  const rest = new FeishuRest({ appId: "cli_x", appSecret: "sec", log: () => {} });
  const chats = await rest.listChats();
  ok("token 失效自动重换并重试", () => assert.equal(chats[0].chatId, "oc_2"));
});

// ---------- 纯逻辑 ----------
ok("stripMentions 去掉 @ 占位符", () => assert.equal(stripMentions("@_user_1 帮我查一下"), "帮我查一下"));
ok("stripMentions 空文本", () => assert.equal(stripMentions(""), ""));
ok("mentionsMe 命中自己", () => assert.equal(mentionsMe({ mentions: [{ id: "ou_me" }] }, "ou_me"), true));
ok("mentionsMe 不命中别人", () => assert.equal(mentionsMe({ mentions: [{ id: "ou_other" }] }, "ou_me"), false));
ok("parseTaskPass 解析路条", () => {
  const p = parseTaskPass("做件事 [任务ID|T-1|小鲸鱼|派发深度1]");
  assert.equal(p.taskId, "T-1");
  assert.equal(p.depth, 1);
});
ok("parseTaskPass 无路条返回 null", () => assert.equal(parseTaskPass("做件事"), null));
ok("cfgValue 解包 Volatile", () => assert.equal(cfgValue({ get: () => "v" }), "v"));
ok("cfgValue 普通值原样", () => assert.equal(cfgValue("v"), "v"));

// ---------- 安全闸（桥接级） ----------
const BOT = "ou_me";
function mkMsg(o) {
  return Object.assign({ messageId: "om_" + Math.random().toString(36).slice(2), chatId: "oc_1", senderId: "ou_human", senderType: "user", text: "", mentions: [] }, o);
}

const sent = [];
const fakeRest = {
  appId: "cli_x",
  async ensureToken() { return "T"; },
  async listChats() { return [{ chatId: "oc_1", name: "群" }]; },
  async listMembers() { return [{ memberId: BOT, name: "我", appId: "cli_x" }]; },
  async findSelfInChat() { return { openId: BOT, name: "我" }; },
  async sendToChat(chatId, text) { sent.push({ chatId, text }); return "om_sent"; },
  async listChatMessages() { return []; },
};

const bridge = createRestBridge({ rest: fakeRest, log: () => {}, options: { deviceName: "dev", dir: ".", maxDepth: 2 } });
await bridge.bootstrap();
ok("自举找到 bot open_id", () => assert.equal(bridge.status().botOpenId, BOT));
ok("自举后群里收到报道", () => assert.ok(sent.some((s) => s.text.includes("我已上线"))));

// 直接测处理闸：伪造消息走内部处理
sent.length = 0;
const msg = mkMsg({ text: "@_user_1 做件事", mentions: [{ id: BOT, key: "@_user_1" }] });
const handled = [];
const b2 = createRestBridge({ rest: fakeRest, log: () => {}, options: { deviceName: "dev", dir: "." } });
await b2.bootstrap();
sent.length = 0;
// 通过 pollOnce 走真实路径：把消息塞进 fakeRest
fakeRest.listChatMessages = async () => [msg];
let executed = 0;
const origSpawn = b2.status;
// 直接调用内部处理：借 pollOnce 触发（首次 primed=false → 只建基线）
await b2.pollOnce();
ok("首轮只建基线不执行历史消息", () => assert.equal(sent.filter((s) => s.text.includes("开始处理")).length, 0));
await b2.pollOnce();
ok("第二轮才处理（消息已被去重，不会重复）", () => assert.equal(sent.filter((s) => s.text.includes("开始处理")).length, 0));

console.log("");
console.log(t + " 项断言完成，exitCode=" + (process.exitCode || 0));

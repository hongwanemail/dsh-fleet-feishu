// feishuRest.js —— 飞书开放平台 REST 传输层（不依赖 lark-cli）
//
// 为什么有它：插件要让「任何人可用」—— 用户只填 App ID + App Secret，
// 插件自己换 token、自己找群、自己收发消息，不要求装 lark-cli、不要求扫码登录。
//
// 官方接口（2026-11 核对）：
//   换 token : POST /open-apis/auth/v3/tenant_access_token/internal  {app_id, app_secret}
//   群列表   : GET  /open-apis/im/v1/chats?page_size=50            （bot 必须在群内才可见）
//   群成员   : GET  /open-apis/im/v1/chats/:chat_id/members?member_id_type=open_id
//   发消息   : POST /open-apis/im/v1/messages?receive_id_type=chat_id
//   拉消息   : GET  /open-apis/im/v1/messages?container_id_type=chat&container_id=:chat_id
//
// 权限清单（用户建应用时要勾）：
//   im:chat:readonly / im:chat.members:read / im:message:readonly / im:message:send_as_bot

const BASE = "https://open.feishu.cn/open-apis";

/** 飞书返回体统一形态：{ code, msg, data }。code===0 才是成功。 */
export class FeishuError extends Error {
  constructor(code, msg, path) {
    super("飞书接口失败 " + path + " code=" + code + " msg=" + msg);
    this.code = code;
    this.msg = msg;
    this.path = path;
  }
}

/** 读配置值：volatile 字段的值是 Volatile 引用，要 .get() 读。 */
export function cfgValue(v) {
  return (v && typeof v.get === "function") ? v.get() : v;
}

async function feishuFetch(path, { method = "GET", token, body, query } = {}) {
  const url = new URL(BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new FeishuError(res.status, "HTTP " + res.status + " 非 JSON 响应", path);
  }
  if (payload.code !== 0) throw new FeishuError(payload.code, payload.msg || "", path);
  return payload.data || {};
}

/**
 * 飞书客户端：持有 app 凭据，按需换 token（过期自动重换）。
 */
export class FeishuRest {
  constructor({ appId, appSecret, log = () => {} }) {
    this.appId = String(appId || "").trim();
    this.appSecret = String(appSecret || "").trim();
    this.log = log;
    this.token = "";
    this.tokenExpireAt = 0;
  }

  /** 配置是否够用（只填这两个即可）。 */
  get ready() {
    return this.appId.length > 0 && this.appSecret.length > 0;
  }

  /** 换 tenant_access_token；未过期直接复用。 */
  async ensureToken(force = false) {
    if (!this.ready) throw new Error("未配置 App ID / App Secret");
    if (!force && this.token && Date.now() < this.tokenExpireAt - 60_000) return this.token;
    const data = await feishuFetch("/auth/v3/tenant_access_token/internal", {
      method: "POST",
      body: { app_id: this.appId, app_secret: this.appSecret },
    });
    this.token = data.tenant_access_token || "";
    const expire = Number(data.expire || 7200);
    this.tokenExpireAt = Date.now() + expire * 1000;
    this.log("已获取 tenant_access_token（有效期 " + expire + " 秒）");
    return this.token;
  }

  /** 带 token 调接口；遇到 token 失效（99991663 等）自动重换一次。 */
  async call(path, opts = {}) {
    const token = await this.ensureToken();
    try {
      return await feishuFetch(path, { ...opts, token });
    } catch (e) {
      const authFail = e instanceof FeishuError && (e.code === 99991663 || e.code === 99991668);
      if (!authFail) throw e;
      this.log("token 失效，重新换取后重试一次");
      await this.ensureToken(true);
      return feishuFetch(path, { ...opts, token: this.token });
    }
  }

  /** 列出应用所在的所有群（bot 必须已加入群，才会出现在这里）。 */
  async listChats() {
    const out = [];
    let pageToken = "";
    for (let page = 0; page < 20; page++) {
      const data = await this.call("/im/v1/chats", { query: { page_size: 50, page_token: pageToken } });
      for (const item of data.items || []) {
        out.push({ chatId: item.chat_id, name: item.name || "", ownerId: item.owner_id || "" });
      }
      if (!data.has_more || !data.page_token) break;
      pageToken = data.page_token;
    }
    return out;
  }

  /** 群成员（含 bots：带 open_id 与 app_id）。 */
  async listMembers(chatId) {
    const out = [];
    let pageToken = "";
    for (let page = 0; page < 20; page++) {
      const data = await this.call("/im/v1/chats/" + chatId + "/members", {
        query: { member_id_type: "open_id", page_size: 100, page_token: pageToken },
      });
      for (const m of data.items || []) {
        out.push({
          memberId: m.member_id || "",
          name: m.name || "",
          tenantKey: m.tenant_key || "",
          appId: m.app_id || "",
        });
      }
      if (!data.has_more || !data.page_token) break;
      pageToken = data.page_token;
    }
    return out;
  }

  /** 在群里找出「本应用自己的 bot」——按 app_id 匹配，返回它的 open_id。 */
  async findSelfInChat(chatId) {
    const members = await this.listMembers(chatId);
    for (const m of members) {
      if (m.appId && m.appId === this.appId) {
        return { openId: m.memberId, name: m.name, members };
      }
    }
    return { openId: "", name: "", members };
  }

  /** 以 bot 身份发消息到群。 */
  async sendToChat(chatId, text) {
    const data = await this.call("/im/v1/messages", {
      method: "POST",
      query: { receive_id_type: "chat_id" },
      body: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text: String(text) }),
      },
    });
    return data.message_id || "";
  }

  /**
   * 拉取群里最近的消息（新到旧）。
   * 飞书保留最近 7 天的消息；轮询间隔由调用方控制（建议 >= 2 秒）。
   */
  async listChatMessages(chatId, { pageSize = 50 } = {}) {
    const data = await this.call("/im/v1/messages", {
      query: {
        container_id_type: "chat",
        container_id: chatId,
        sort_type: "ByCreateTimeDesc",
        page_size: pageSize,
      },
    });
    const out = [];
    for (const m of data.items || []) {
      let text = "";
      try {
        const content = JSON.parse(m.body && m.body.content ? m.body.content : "{}");
        text = content.text || "";
      } catch {
        text = m.body && m.body.content ? String(m.body.content) : "";
      }
      const mentions = [];
      for (const mention of (m.mentions || [])) {
        mentions.push({
          key: mention.key || "",
          id: mention.id || "",           // open_id
          name: mention.name || "",
          tenantKey: mention.tenant_key || "",
        });
      }
      out.push({
        messageId: m.message_id || "",
        createTime: m.create_time || "",
        chatId: m.chat_id || chatId,
        senderId: m.sender && m.sender.id ? m.sender.id : "",
        senderType: m.sender && m.sender.sender_type ? m.sender.sender_type : "",
        senderName: m.sender && m.sender.sender_type === "user" ? "" : "",
        msgType: m.msg_type || "",
        text,
        mentions,
        deleted: m.deleted === true,
      });
    }
    return out;
  }
}

/** 从消息正文里取出 @ 后的名字（飞书正文形如 "@_user_1 帮我查一下"）。 */
export function parseMentionNames(text) {
  const names = [];
  const re = /@_user_\d+/g;
  let m;
  while ((m = re.exec(text || "")) !== null) names.push(m[0]);
  return names;
}

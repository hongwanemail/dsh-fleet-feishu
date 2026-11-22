// fleet-feishu 客户端半侧（browser half）—— 让插件在「设置 → 插件」页里有一张可编辑的配置卡片。
//
// 官方依据（2026-11-22 读官方文档 + 读客户端实现得出）：
//   · reference/cookbook/adding-a-settings-card —— 「新增设置页」分步指南
//   · reference/subsystems/settings            —— ctx.settings / ctx.settingsController 契约
//   · reference/subsystems/client-modules      —— 浏览器半侧如何挂载（exports["./client"] + dsh.client）
//   · 官方实现样板：dsh-client-ui-settings-agent-loop（子智能体卡片）的 client.js
//
// 机制：
//   1. 插件在 profile 里的条目 id = settings 命名空间（本插件 = "fleet-feishu"）
//   2. host 侧（dsh-settings）把该条目的【volatile Config 字段】投影成表单描述符
//   3. 客户端用 ctx.configForms.get(ns) 拿到该命名空间的表单模型，
//      用 ctx.configForms.whileServed([ns], cb) 在 host 提供该命名空间时才注册卡片
//   4. 卡片注册进 Plugins 页的 plugins.item 槽 → 渲染在插件详情页的 data-plugin-config 区块
//   5. 保存走 form.mutate(ops, expectedRevision) → 写回 profile patch → 即时生效
//
// 本文件是 lazy-CJS factory 格式（客户端模块系统要求）：
//   window.__ModuleLoader__.load({ id, factory(require) })
window.__ModuleLoader__.load({
  id: "dsh-fleet-feishu",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react_jsx_runtime = require("react/jsx-runtime");
    const ui = require("@deepseek-ai/dsh-client-ui-primitives");

    /** locale 命名空间（本卡片自己的文案） */
    const NS = "settings.fleetFeishu";
    /** settings 命名空间 = 插件在 profile 里的条目 id（host 侧按它投影表单） */
    const FLEET_NS = "fleet-feishu";

    const zh = {
      title: "飞书飞派",
      description: "把本机 DSH 接入飞书群：群里 @ 本 bot 派任务，本机执行并回执。",
      deviceName: "设备署名",
      deviceNameHint: "你在群里的名字，例如「小鲸鱼-办公室PC」。别人 @ 这个名字才能派活给你。",
      chatId: "群 ID",
      chatIdHint: "飞书群 ID（oc_ 开头）。打开群 → 群设置 → 群 ID 即可复制。机器人只在这个群里派活。",
      botOpenId: "机器人 open_id",
      botOpenIdHint: "本 bot 的 open_id（ou_ 开头）——留空即可：插件会拉群名册按自己的飞书应用自动匹配。",
      save: "保存",
      saving: "保存中…",
      saveFailed: "部署未接受这些值，已保留草稿供你修正。",
      overridden: "已覆盖",
      reset: "恢复默认",
      readOnly: "此部署以只读方式存储设置。",
      unavailable: "插件未加载，暂时无法配置。",
    };
    const en = {
      title: "Fleet Feishu",
      description: "Connect this DSH to a Feishu group: @ the bot to dispatch work here.",
      deviceName: "Device name",
      deviceNameHint: "Your name in the group, e.g. “小鲸鱼-办公室PC”. People @ this name to assign you work.",
      chatId: "Chat ID",
      chatIdHint: "The Feishu group ID (starts with oc_). Open the group → Group settings → Group ID.",
      botOpenId: "Bot open_id",
      botOpenIdHint: "This bot's open_id (starts with ou_) — leave empty to auto-detect from the group roster.",
      save: "Save",
      saving: "Saving…",
      saveFailed: "The deployment did not accept these values; your draft is kept for correction.",
      overridden: "Overridden",
      reset: "Reset to default",
      readOnly: "This deployment stores settings read-only.",
      unavailable: "This plugin is not loaded, so it cannot be configured right now.",
    };

    const formLabels = (t) => ({
      save: t("save"),
      saving: t("saving"),
      saveFailed: t("saveFailed"),
      overridden: t("overridden"),
      reset: t("reset"),
      readOnly: t("readOnly"),
    });

    /** 卡片控制器：把 host 的 settings 命名空间桥接到页面上的暂存表单 */
    class FleetCardController {
      constructor(scope) {
        this.form = new ui.SettingsFormModel(scope, [
          ui.settingsTextField("device_name"),
          ui.settingsTextField("chat_id"),
          ui.settingsTextField("bot_open_id"),
        ]);
        this.store = this.form.bind(() => this.projection());
      }
      projection() {
        return {
          ...this.form.shell(),
          device_name: this.form.field("device_name"),
          chat_id: this.form.field("chat_id"),
          bot_open_id: this.form.field("bot_open_id"),
        };
      }
      /** 页面槽注册时注入的 face：快照 + 表单动作 */
      inject() {
        return {
          hooks: { fleetCard: this.store },
          ...this.form.actions(),
        };
      }
      dispose() {
        this.form.dispose();
      }
    }

    /** 卡片组件：summary 视图给一行说明；page 视图给表单 */
    function FleetCard(props) {
      const { t } = props;
      const state = props.useFleetCard((snapshot) => snapshot);
      if (props.view === "summary") return t("description");
      const field = (key, id, label, hint) =>
        react_jsx_runtime.jsx(ui.SettingsValueField, {
          id,
          label,
          hint,
          overriddenLabel: t("overridden"),
          resetLabel: t("reset"),
          disabled: !state.writable,
          ...state[key],
          onEdit: (text) => { props.edit(key, text); },
          onReset: () => { props.resetField(key); },
        });
      return react_jsx_runtime.jsx(ui.SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [
          field("device_name", "plugin-config-fleet-device-name", t("deviceName"), t("deviceNameHint")),
          field("chat_id", "plugin-config-fleet-chat-id", t("chatId"), t("chatIdHint")),
          field("bot_open_id", "plugin-config-fleet-bot-open-id", t("botOpenId"), t("botOpenIdHint")),
        ],
      });
    }

    const inject = ["slots", "locale", "configForms"];

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        "fleet-feishu: dictionaries",
      );
      const t = ctx.locale.bind(NS);
      const card = new FleetCardController(ctx.configForms.get(FLEET_NS));
      ctx.effect(() => () => { card.dispose(); }, "fleet-feishu: form subscription");
      ctx.effect(
        () => ctx.configForms.whileServed([FLEET_NS], () =>
          ctx.slots.inject("plugins.item", () =>
            ctx.slots.register(
              {
                name: "plugins.item",
                id: "fleet-feishu",
                order: 30,
                label: () => t("title"),
                locale: NS,
                inject: () => card.inject(),
              },
              FleetCard,
            ),
          ),
        ),
        "fleet-feishu: page",
      );
    }

    // 导出 inject：Cordis 靠它才知道要注入哪些服务
    // 看不导出的表现：客户端报错「cannot get property "locale" without inject」
    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

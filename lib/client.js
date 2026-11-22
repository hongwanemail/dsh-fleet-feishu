// fleet-feishu 客户端半侧（browser half）—— 配置页：只填 App ID + App Secret。
//
// 官方写法（对照 @deepseek-ai/dsh-client-ui-settings-agent-loop）：
//   window.__ModuleLoader__.load({ id, factory(require) })
//   exports.inject = ['slots','locale','configForms']   ← 漏了会报 cannot get property "locale" without inject
//   ctx.configForms.get(命名空间) → 表单模型
//   ctx.configForms.whileServed([命名空间], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({...}, Card)))
//
// 命名空间 = profile 里的行 id（fleet-feishu）。
window.__ModuleLoader__.load({
  id: "dsh-fleet-feishu",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const { jsx } = require("react/jsx-runtime");
    const ui = require("@deepseek-ai/dsh-client-ui-primitives");

    const NS = "settings.fleetFeishu";
    const FLEET_NS = "fleet-feishu";

    const zh = {
      title: "飞书飞派",
      description: "把本机 DSH 接进飞书群：群里 @ 本 bot 派任务，本机执行并回执。",
      appId: "App ID",
      appIdHint: "飞书应用 App ID（cli_ 开头）。开放平台 → 你的应用 → 凭证与基础信息 → App ID。",
      appSecret: "App Secret",
      appSecretHint: "同一页面的 App Secret。只存在本机，不外传。应用需开通权限：im:chat:readonly、im:chat.members:read、im:message:readonly、im:message:send_as_bot。",
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
      appId: "App ID",
      appIdHint: "Your Feishu app ID (starts with cli_). Open Platform → your app → Credentials → App ID.",
      appSecret: "App Secret",
      appSecretHint: "App Secret from the same page. Stored locally only. The app needs: im:chat:readonly, im:chat.members:read, im:message:readonly, im:message:send_as_bot.",
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

    /** 把 host 的 settings 命名空间桥接到页面上的暂存表单 */
    class FleetCardController {
      constructor(scope) {
        this.form = new ui.SettingsFormModel(scope, [
          ui.settingsTextField("app_id"),
          ui.settingsTextField("app_secret"),
        ]);
        this.store = this.form.bind(() => this.projection());
      }
      projection() {
        return {
          ...this.form.shell(),
          app_id: this.form.field("app_id"),
          app_secret: this.form.field("app_secret"),
        };
      }
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

    /** 卡片：summary 视图给一行说明；page 视图给表单 */
    function FleetCard(props) {
      const { t } = props;
      const state = props.useFleetCard((snapshot) => snapshot);
      if (props.view === "summary") return t("description");
      const field = (key, id, label, hint) =>
        jsx(ui.SettingsValueField, {
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
      return jsx(ui.SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [
          field("app_id", "plugin-config-fleet-app-id", t("appId"), t("appIdHint")),
          field("app_secret", "plugin-config-fleet-app-secret", t("appSecret"), t("appSecretHint")),
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
                id: FLEET_NS,
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

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

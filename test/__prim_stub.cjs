// ui-primitives 的最小替身：只提供 client.js 用到的 API 形状
class SettingsFormModel {
  constructor(scope, fields) { this.scope = scope; this.fields = fields; }
  bind(fn) { this._fn = fn; return { get: () => fn(this.projection()) }; }
  shell() { return { writable: true, revision: 1 }; }
  field(key) { return { value: "", overridden: false }; }
  actions() { return { save: () => {}, discard: () => {}, edit: () => {}, resetField: () => {} }; }
  dispose() {}
}
function settingsTextField(key) { return { key, type: "text" }; }
function settingsNumberField(key) { return { key, type: "number" }; }
const SettingsForm = () => null;
const SettingsValueField = () => null;
module.exports = { SettingsFormModel, settingsTextField, settingsNumberField, SettingsForm, SettingsValueField };

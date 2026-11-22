// 模拟客户端加载 client 半侧：把 client.js 的 factory 跑一遍，
// 注入假的 ctx（slots/locale/configForms），验证：
//   1) 模块能被 factory 正常加载（不抛错）
//   2) exports.inject 已导出（这正是之前报错的那一行）
//   3) apply() 会调用 configForms.whileServed + slots.inject + slots.register
//   4) 注册的卡片 id = fleet-feishu（= profile 条目 id = settings 命名空间）
const path = require("path");
const fs = require("fs");

// 模拟 window.__ModuleLoader__
const loaded = [];
global.window = {
  __ModuleLoader__: {
    load(def) {
      loaded.push(def);
      console.log("  ✓ 模块被请求加载: id=" + def.id);
      // 客户端会调用 factory(require)
      const module = { exports: {} };
      const req = (name) => {
        if (name === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null, Fragment: "Fragment" };
        if (name === "@deepseek-ai/dsh-client-ui-primitives") return require("./__prim_stub.cjs");
        throw new Error("未预期的 require: " + name);
      };
      const exported = def.factory(req);
      global.__exported = exported;
      return exported;
    },
  },
};

const clientPath = path.resolve(__dirname, "../lib/client.js");
require(clientPath);

const exported = global.__exported;
console.log("");
console.log("=== 导出检查 ===");
console.log("  exports.inject 存在:", !!exported.inject, exported.inject ? JSON.stringify(exported.inject) : "");
console.log("  exports.apply  存在:", !!exported.apply);
console.log("  exports.NS     存在:", !!exported.NS, exported.NS || "");

// 假 ctx
const calls = { whileServed: [], inject: [], register: [], locale: [], effect: [] };
const fakeCard = { inject: () => ({ hooks: { fleetCard: {} }, save: () => {}, discard: () => {}, edit: () => {}, resetField: () => {} }) };
const ctx = {
  effect: (fn, label) => { calls.effect.push(label); const d = fn(); return d; },
  locale: {
    register: (ns, dicts, label) => { calls.locale.push(label); return () => {}; },
    bind: (ns) => (key) => "TXT:" + key,
  },
  configForms: {
    get: (ns) => ({ __scope: ns }),
    whileServed: (ns, cb) => { calls.whileServed.push(ns); return cb(); },
  },
  slots: {
    inject: (name, cb) => { calls.inject.push(name); return cb(); },
    register: (def, Component) => { calls.register.push({ name: def.name, id: def.id, label: typeof def.label === "function" ? def.label() : def.label, component: Component && Component.name }); return () => {}; },
  },
};

console.log("");
console.log("=== 执行 apply() ===");
try {
  exported.apply(ctx);
  console.log("  ✓ apply() 未抛错");
} catch (e) {
  console.log("  ❌ apply() 抛错:", e.message);
  process.exit(1);
}

console.log("");
console.log("=== 调用轨迹 ===");
console.log("  configForms.whileServed:", JSON.stringify(calls.whileServed));
console.log("  slots.inject          :", JSON.stringify(calls.inject));
console.log("  slots.register       :", JSON.stringify(calls.register));
console.log("  locale.register      :", JSON.stringify(calls.locale));

const served = calls.whileServed.flat();
const ok =
  !!exported.inject &&
  served.includes("fleet-feishu") &&
  calls.inject.includes("plugins.item") &&
  calls.register.some((r) => r.id === "fleet-feishu" && r.name === "plugins.item") &&
  calls.register.some((r) => r.component === "FleetCard");
console.log("");
console.log(ok ? "  ✅ client 半侧加载与注册链路正常" : "  ❌ 注册链路有问题");
process.exit(ok ? 0 : 1);

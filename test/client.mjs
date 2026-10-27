// Client-half test: loads `lib/client.js` (the browser bundle) in Node with a
// stub `window.__ModuleLoader__`, a hand-rolled React hooks runtime, and a
// stubbed `fetch` that answers the plugin's own HTTP routes in memory.
//
// It verifies the two surfaces the browser half contributes:
//   1. the settings page still renders and now reports the per-conversation
//      override aggregate;
//   2. the composer "技能提示词" bar renders per conversation, lists every skill
//      with the resolved state, and POSTs the right override payloads.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = join(here, "..", "lib", "client.js");

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok  - " + label); }
  else { fail++; console.log("  FAIL - " + label + (extra !== undefined ? " :: " + extra : "")); }
}

// ---------------------------------------------------------------------------
// mini hooks runtime (the subset the plugin uses: createElement/useState/
// useEffect/useCallback) — enough to mount, re-render, and fire handlers.
// ---------------------------------------------------------------------------
const Fragment = Symbol("Fragment");
const slots = [];
let cursor = 0;
let rerenderRequested = false;
let pendingEffects = [];

function createElement(type, props) {
  const merged = Object.assign({}, props || {});
  const children = Array.prototype.slice.call(arguments, 2);
  if (children.length === 1) merged.children = children[0];
  else if (children.length > 1) merged.children = children;
  return { type, props: merged };
}

function useState(initial) {
  const index = cursor++;
  if (!slots[index]) {
    slots[index] = {
      kind: "state",
      value: typeof initial === "function" ? initial() : initial
    };
  }
  const slot = slots[index];
  const setState = (next) => {
    const value = typeof next === "function" ? next(slot.value) : next;
    if (Object.is(value, slot.value)) return;
    slot.value = value;
    rerenderRequested = true;
  };
  return [slot.value, setState];
}

function sameDeps(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

function useEffect(fn, deps) {
  const index = cursor++;
  const slot = slots[index] || (slots[index] = { kind: "effect" });
  if (!slot.initialized || !sameDeps(slot.deps, deps)) {
    slot.initialized = true;
    slot.deps = deps;
    pendingEffects.push(fn);
  }
}

function useCallback(fn, deps) {
  const index = cursor++;
  const slot = slots[index] || (slots[index] = { kind: "callback" });
  if (!slot.value || !sameDeps(slot.deps, deps)) {
    slot.value = fn;
    slot.deps = deps;
  }
  return slot.value;
}

function useRef(initial) {
  const index = cursor++;
  const slot = slots[index] || (slots[index] = { kind: "ref", value: { current: initial } });
  return slot.value;
}

const ReactShim = { createElement, Fragment, useState, useEffect, useCallback, useRef };

// The popover registers document listeners; a no-op stub is all the shim needs.
const listeners = [];
globalThis.document = {
  addEventListener: (type) => listeners.push(type),
  removeEventListener: () => {}
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Slot entries may be wrappers (`() => createElement(Page)`), so unwrap the
// root before the hooks of the real component run in this pass.
function resolveRoot(fn, props) {
  let node = fn(props);
  for (let guard = 0; guard < 10 && node && typeof node.type === "function"; guard++) {
    node = node.type(node.props);
  }
  return node;
}

async function render(component, props) {
  let tree;
  for (let round = 0; round < 25; round++) {
    cursor = 0;
    rerenderRequested = false;
    pendingEffects = [];
    tree = resolveRoot(component, props);
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) effect();
    for (let i = 0; i < 6; i++) await tick();
    if (!rerenderRequested) return tree;
  }
  throw new Error("component never settled");
}

// tree helpers -------------------------------------------------------------
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return; }
  if (typeof node === "string" || typeof node === "number") { visit({ text: String(node) }); return; }
  if (typeof node.type === "function") { walk(node.type(node.props), visit); return; }
  visit(node);
  walk(node.props && node.props.children, visit);
}

function textOf(node) {
  let out = "";
  walk(node, (item) => { if (item.text !== undefined) out += " " + item.text; });
  return out.replace(/\s+/g, " ").trim();
}

function findAll(node, predicate) {
  const hits = [];
  walk(node, (item) => { if (item.type !== undefined && predicate(item)) hits.push(item); });
  return hits;
}

function buttons(node) {
  return findAll(node, (item) => item.type === "button");
}

// One skill row: the smallest container that mentions the skill and carries a
// checkbox (the expanded list also contains a wider wrapper holding every row).
function rowFor(node, label) {
  const candidates = findAll(node, (item) => {
    if (item.type !== "div") return false;
    if (!textOf(item).includes(label)) return false;
    return findAll(item, (child) => child.type === "input" && child.props.type === "checkbox").length > 0;
  });
  candidates.sort((a, b) => textOf(a).length - textOf(b).length);
  return candidates[0];
}

function checkboxFor(node, label) {
  const row = rowFor(node, label);
  if (!row) return undefined;
  return findAll(row, (item) => item.type === "input" && item.props.type === "checkbox")[0];
}

// ---------------------------------------------------------------------------
// stubbed host: an in-memory echo of the plugin's own HTTP routes
// ---------------------------------------------------------------------------
const NOTES = {
  "SKILL-GUIDE.md": { name: "skill-guide", description: "使用指南", enabled: true, body: "指南正文" },
  "pentest-workflow.md": { name: "pentest-workflow", description: "渗透流程", enabled: false, body: "渗透正文" }
};
const overridesBySession = new Map();
const calls = [];

function sessionIdOfBody(body) {
  return body && typeof body.sessionId === "string" ? body.sessionId : "";
}

function sessionPayload(sessionId) {
  const own = overridesBySession.get(sessionId) || {};
  const skills = Object.keys(NOTES).map((file) => {
    const note = NOTES[file];
    const override = Object.prototype.hasOwnProperty.call(own, file) ? own[file] : null;
    return {
      file,
      displayName: file.replace(/\.md$/, ""),
      name: note.name,
      description: note.description,
      contentLength: note.body.length,
      defaultEnabled: note.enabled,
      override,
      effective: override === null ? note.enabled : override
    };
  });
  return {
    sessionId,
    chain: [sessionId],
    skills,
    defaultCount: skills.filter((s) => s.defaultEnabled).length,
    effectiveCount: skills.filter((s) => s.effective).length,
    overrideCount: skills.filter((s) => s.override !== null).length
  };
}

function statePayload() {
  const skills = Object.keys(NOTES).map((file) => ({
    file,
    displayName: file.replace(/\.md$/, ""),
    name: NOTES[file].name,
    description: NOTES[file].description,
    enabled: NOTES[file].enabled,
    contentLength: NOTES[file].body.length,
    content: NOTES[file].body
  }));
  return {
    vaultDir: "E:\\vault",
    skillsDir: "E:\\vault\\skills",
    defaultVaultDir: "E:\\vault",
    sessionOverrideCount: overridesBySession.size,
    sessionOverrides: Array.from(overridesBySession.keys()).map((id) => ({ sessionId: id, count: 1, updatedAt: 1 })),
    skills
  };
}

globalThis.fetch = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : {};
  calls.push({ url, body });
  const reply = (payload) => ({ ok: true, status: 200, json: async () => payload });
  if (url.endsWith("/state")) return reply(statePayload());
  if (url.endsWith("/session")) {
    const sessionId = sessionIdOfBody(body);
    if (!sessionId) return reply({ ok: false, error: "sessionId is required" });
    return reply(sessionPayload(sessionId));
  }
  if (url.endsWith("/session-override")) {
    const sessionId = sessionIdOfBody(body);
    if (!sessionId) return reply({ ok: false, error: "sessionId is required" });
    const own = overridesBySession.get(sessionId) || {};
    if (body.enabled === null) delete own[body.file];
    else own[body.file] = !!body.enabled;
    if (Object.keys(own).length === 0) overridesBySession.delete(sessionId);
    else overridesBySession.set(sessionId, own);
    return reply(sessionPayload(sessionId));
  }
  if (url.endsWith("/session-reset")) {
    overridesBySession.delete(sessionIdOfBody(body));
    return reply(sessionPayload(sessionIdOfBody(body)));
  }
  if (url.endsWith("/session-reset-all")) {
    const cleared = overridesBySession.size;
    overridesBySession.clear();
    return reply(Object.assign(statePayload(), { cleared }));
  }
  return reply({ ok: false, error: "unexpected route " + url });
};

// ---------------------------------------------------------------------------
// load the bundle exactly like the browser does
// ---------------------------------------------------------------------------
let bundle;
globalThis.window = { __ModuleLoader__: { load: (definition) => { bundle = definition; } } };
await import(pathToFileURL(CLIENT_FILE).href);
check("bundle registers through __ModuleLoader__", !!bundle);
check("bundle id kept", bundle && bundle.id === "dsh-skillmanager", bundle && bundle.id);

const clientModule = bundle.factory((specifier) => {
  if (specifier === "react") return ReactShim;
  throw new Error("unexpected require: " + specifier);
});
check("client module exposes apply", typeof clientModule.apply === "function");
check("client module injects slots", Array.isArray(clientModule.inject) && clientModule.inject.includes("slots"));

// ---------------------------------------------------------------------------
// apply(): both slots are contributed
// ---------------------------------------------------------------------------
const registered = [];
const injected = [];
const fakeSlots = {
  inject(key, callback) { injected.push(key); callback(); return () => {}; },
  register(spec, component) { registered.push({ spec, component }); return () => {}; }
};
clientModule.apply({ get: (name) => (name === "slots" ? fakeSlots : undefined) });

check("settings slot requested", injected.includes("settings.section"), injected.join(","));
check("conversation header slot requested", injected.includes("conversation.session.header.actions"), injected.join(","));
check("composer dock slot requested", injected.includes("conversation.input.dock"), injected.join(","));
const settingsEntry = registered.find((r) => r.spec.name === "settings.section");
const cornerEntry = registered.find((r) => r.spec.name === "conversation.session.header.actions");
const blankEntry = registered.find((r) => r.spec.name === "conversation.input.dock");
check("settings page registered", !!settingsEntry && settingsEntry.spec.id === "dsh-skillmanager");
check("settings page keeps its label", !!settingsEntry && settingsEntry.spec.label === "固定提示词");
check("corner entry registered", !!cornerEntry, JSON.stringify(registered.map((r) => r.spec.name)));
check("corner entry has a stable id", !!cornerEntry && cornerEntry.spec.id === "dsh-skillmanager-session-skills");
check("corner entry injects the session id", !!cornerEntry && cornerEntry.spec.inject("session-7").sessionId === "session-7");
check("corner entry asks for corner placement", !!cornerEntry && cornerEntry.spec.inject("session-7").placement === "corner");
check("blank entry registered separately", !!blankEntry && blankEntry.spec.id === "dsh-skillmanager-empty-session-skills");
check("blank entry asks for inline placement", !!blankEntry && blankEntry.spec.inject("session-7").placement === "inline");

// ---------------------------------------------------------------------------
// the corner entry: per-conversation state, expansion, toggles
// ---------------------------------------------------------------------------
async function mountBar(props) {
  // fresh hook state per mount
  slots.length = 0;
  cursor = 0;
  rerenderRequested = false;
  pendingEffects = [];
  return render(cornerEntry.component, Object.assign({ placement: "corner" }, props));
}

let tree = await mountBar({ sessionId: "session-7", session: { sessionId: "session-7" } });
check("corner entry asks the host for this conversation", calls.some((c) => c.url.endsWith("/session") && c.body.sessionId === "session-7"));
check("collapsed pill is titled 技能提示词", textOf(tree).includes("技能提示词"), textOf(tree));
check("collapsed pill stays one row on the default state", textOf(tree).includes("1/2"), textOf(tree));
check("collapsed pill shows no session marker by default", !textOf(tree).includes("本会话"), textOf(tree));
check("collapsed pill does not list skills yet", !textOf(tree).includes("pentest-workflow"), textOf(tree));
check("collapsed pill wraps in an absolute container", tree.props.style.position === "absolute", JSON.stringify(tree.props.style));
check("corner is anchored at the panel's top-left", tree.props.style.left === 12 && tree.props.style.top === 86, JSON.stringify(tree.props.style));

const headerButton = buttons(tree).find((b) => textOf(b).includes("技能提示词"));
check("pill toggles the panel", !!headerButton && headerButton.props["aria-expanded"] === false);
headerButton.props.onClick();
tree = await render(cornerEntry.component, { sessionId: "session-7", placement: "corner", session: { sessionId: "session-7" } });

check("expanded panel lists every skill", textOf(tree).includes("SKILL-GUIDE") && textOf(tree).includes("pentest-workflow"), textOf(tree));
check("rows explain the default", textOf(tree).includes("默认注入") && textOf(tree).includes("默认停用"), textOf(tree));
check("rows admit they follow the settings page", textOf(tree).includes("跟随设置 · "), textOf(tree));
check("panel header reports the follow-the-default state", textOf(tree).includes("跟随设置 · 生效 1/2"), textOf(tree));
check("panel scrolls instead of growing", findAll(tree, (item) => item.props && item.props.style && item.props.style.overflowY === "auto").length >= 1);

// liquid-glass material: translucent tint + backdrop blur + edge light + grain
const glassPanel = findAll(tree, (item) => item.props && item.props.style && item.props.style.maxHeight && item.props.style.backdropFilter)[0];
check("panel is a glass surface with a backdrop blur", !!glassPanel && /blur\(/.test(glassPanel.props.style.backdropFilter), glassPanel && glassPanel.props.style.backdropFilter);
check("panel tint is translucent, not solid", !!glassPanel && /color-mix|rgba\(/.test(String(glassPanel.props.style.backgroundColor)), glassPanel && glassPanel.props.style.backgroundColor);
check("panel keeps the -webkit- fallback", !!glassPanel && glassPanel.props.style.WebkitBackdropFilter === glassPanel.props.style.backdropFilter);
check("panel separates by shadow only, no white rim", !!glassPanel
  && glassPanel.props.style.border === "none"
  && !/inset/.test(glassPanel.props.style.boxShadow)
  && /0 16px 40px/.test(glassPanel.props.style.boxShadow), glassPanel && glassPanel.props.style.boxShadow);
check("panel adds a specular sweep layer", findAll(tree, (item) => item.props && item.props.style && /radial-gradient/.test(String(item.props.style.background))).length >= 1);
check("panel adds a grain layer", findAll(tree, (item) => item.props && item.props.style && /feTurbulence/.test(String(item.props.style.backgroundImage))).length >= 1);
const glassPill = buttons(tree).find((b) => textOf(b).includes("技能提示词"));
check("pill is glass too", !!glassPill && /blur\(/.test(String(glassPill.props.style.backdropFilter)), glassPill && glassPill.props.style.backdropFilter);
check("pill is fully rounded", !!glassPill && glassPill.props.style.borderRadius === 999);
check("no per-row reset button before an override", !textOf(tree).includes("清除本会话开关"));

const pentestBox = checkboxFor(tree, "pentest-workflow");
check("default-off skill offers a switch", !!pentestBox);
check("switch starts unchecked", !!pentestBox && pentestBox.props.checked === false);
pentestBox.props.onChange({ target: { checked: true } });
tree = await render(cornerEntry.component, { sessionId: "session-7", placement: "corner", session: { sessionId: "session-7" } });

const overrideCall = calls.filter((c) => c.url.endsWith("/session-override")).pop();
check("toggling posts the session, file and value", !!overrideCall
  && overrideCall.body.sessionId === "session-7"
  && overrideCall.body.file === "pentest-workflow.md"
  && overrideCall.body.enabled === true, JSON.stringify(overrideCall && overrideCall.body));
check("panel now reports the per-session switch", textOf(tree).includes("1 项本会话开关"), textOf(tree));
check("row shows the conversation-level decision", textOf(tree).includes("本会话注入"), textOf(tree));
check("switch is now checked", checkboxFor(tree, "pentest-workflow").props.checked === true);
check("pill marks an overridden conversation", textOf(tree).includes("2/2 · 本会话"), textOf(tree));
check("a follow-the-default button appeared", textOf(tree).includes("跟随设置"));

const followButton = buttons(tree).find((b) => textOf(b) === "跟随设置");
followButton.props.onClick();
tree = await render(cornerEntry.component, { sessionId: "session-7", placement: "corner", session: { sessionId: "session-7" } });
const clearCall = calls.filter((c) => c.url.endsWith("/session-override")).pop();
check("follow-the-default clears with enabled:null", clearCall && clearCall.body.enabled === null, JSON.stringify(clearCall && clearCall.body));
check("panel returns to the default state", textOf(tree).includes("跟随设置 · 生效 1/2"), textOf(tree));

// a second conversation starts clean
overridesBySession.set("session-7", { "pentest-workflow.md": true });
tree = await mountBar({ sessionId: "other-session", session: { sessionId: "other-session" } });
check("another conversation is not affected", textOf(tree).includes("1/2") && !textOf(tree).includes("本会话"), textOf(tree));

// per-session reset from the panel footer
slots.length = 0;
tree = await mountBar({ session: { sessionId: "session-7" } });
const headerButton2 = buttons(tree).find((b) => textOf(b).includes("技能提示词"));
headerButton2.props.onClick();
tree = await render(cornerEntry.component, { placement: "corner", session: { sessionId: "session-7" } });
const resetAll = buttons(tree).find((b) => textOf(b) === "全部恢复默认");
check("footer offers 全部恢复默认", !!resetAll && resetAll.props.disabled === false);
resetAll.props.onClick();
tree = await render(cornerEntry.component, { placement: "corner", session: { sessionId: "session-7" } });
check("reset posts to the session reset route", calls.some((c) => c.url.endsWith("/session-reset") && c.body.sessionId === "session-7"));
check("reset clears the conversation", !textOf(tree).includes("项本会话开关"), textOf(tree));

// the session-scoped fallback: no inject prop, only the owner's session snapshot
slots.length = 0;
const fallbackTree = await mountBar({ session: { sessionId: "session-9" } });
check("session snapshot id is used when inject is absent",
  calls.some((c) => c.url.endsWith("/session") && c.body.sessionId === "session-9"));
check("bar still renders", textOf(fallbackTree).includes("技能提示词"));

// no session at all -> nothing to scope to
slots.length = 0;
const noSession = await mountBar({});
check("no session renders nothing", noSession === null);

// host failure -> a retry affordance instead of silence
slots.length = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
const failedTree = await mountBar({ sessionId: "session-x" });
globalThis.fetch = realFetch;
check("host failure keeps a retry affordance", textOf(failedTree).includes("不可用"), textOf(failedTree));
check("retry pill is clickable", buttons(failedTree).some((b) => typeof b.props.onClick === "function"));

// the blank-conversation entry only fills the gap while the header is hidden
slots.length = 0;
const blankIdle = await render(blankEntry.component, { placement: "inline", session: { sessionId: "session-7", blank: false } });
check("dock entry stays hidden once the conversation has turns", blankIdle === null);
slots.length = 0;
const blankTree = await render(blankEntry.component, { placement: "inline", session: { sessionId: "session-7", blank: true } });
check("dock entry renders in a blank conversation", textOf(blankTree).includes("技能提示词"), textOf(blankTree));
check("blank entry lays out in flow, not absolutely", blankTree.props.style.position === undefined, JSON.stringify(blankTree.props.style));

// ---------------------------------------------------------------------------
// the settings page: global default + the new per-conversation card
// ---------------------------------------------------------------------------
slots.length = 0;
overridesBySession.set("session-7", { "pentest-workflow.md": true });
const settingsTree = await render(settingsEntry.component, {});
const settingsText = textOf(settingsTree);
check("settings page still lists the notes", settingsText.includes("SKILL-GUIDE") && settingsText.includes("pentest-workflow"), settingsText);
check("settings page explains the global default", settingsText.includes("全局默认"), settingsText);
check("settings page reports conversations with overrides", settingsText.includes("1 个对话存在临时开关"), settingsText);
const clearAllButton = buttons(settingsTree).find((b) => textOf(b) === "清除所有对话的临时开关");
check("settings page offers 清除所有对话的临时开关", !!clearAllButton && clearAllButton.props.disabled === false);
clearAllButton.props.onClick();
await tick();
check("clear-all posts to the reset-all route", calls.some((c) => c.url.endsWith("/session-reset-all")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

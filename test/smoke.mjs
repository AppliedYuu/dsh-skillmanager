// Local smoke test for the dsh-skillmanager host half against a mock ctx.
// Runs WITHOUT a real DSH host: exercises the registered HTTP handlers and the
// systemPrompt section text against scratch vault directories, verifying the
// Obsidian-folder storage, frontmatter read/write, toggle/update/remove,
// pointer redirection, path-safety guards, and the per-conversation override
// layer (including subagent inheritance and persistence).
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const scratch = mkdtempSync(join(tmpdir(), "skillmgr-"));
const vault1 = join(scratch, "vault1");
const vault2 = join(scratch, "vault2");
const cfg = join(scratch, "dsm-config.json");
const overridesFile = join(scratch, "dsm-sessions.json");

process.env.DSH_SKILLMANAGER_DEFAULT_VAULT = vault1;
process.env.DSH_SKILLMANAGER_CONFIG = cfg;
process.env.DSH_SKILLMANAGER_OVERRIDES = overridesFile;
process.env.DSH_SKILLMANAGER_SKIP_MIGRATE = "1";

const { apply } = await import("../lib/index.js");

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok  - " + label); }
  else { fail++; console.log("  FAIL - " + label + (extra !== undefined ? " :: " + extra : "")); }
}

// ---- mock services ----
const registered = [];
const sections = [];
// Session store stand-in: sub-1 is a subagent child of s-alpha (override inheritance).
const sessionHeaders = { "sub-1": { parentSession: "s-alpha" } };
const ctx = {
  get: (k) => {
    if (k === "systemPrompt") return { section: (spec) => { sections.push(spec); return () => {}; } };
    if (k === "webServer") return { register: (spec) => { registered.push(spec); return () => {}; } };
    if (k === "sessions") {
      return { get: (id) => (sessionHeaders[id] ? { id, header: sessionHeaders[id] } : undefined) };
    }
    return null;
  },
  effect: (fn) => { fn(); }
};
apply(ctx);

async function call(route, body) {
  const spec = registered.find((r) => r.path === route);
  if (!spec) throw new Error("route not registered: " + route);
  let out = null;
  const res = { writeHead: () => {}, end: (b) => { out = JSON.parse(b); } };
  const req = { [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body || {})); } };
  await spec.handler(req, res);
  return out;
}
const stateRoute = "/api/dsh-skillmanager/state";
const configRoute = "/api/dsh-skillmanager/config";
const addRoute = "/api/dsh-skillmanager/add";
const importRoute = "/api/dsh-skillmanager/import";
const toggleRoute = "/api/dsh-skillmanager/toggle";
const updateRoute = "/api/dsh-skillmanager/update";
const removeRoute = "/api/dsh-skillmanager/remove";
const openFolderRoute = "/api/dsh-skillmanager/open-folder";
const sessionRoute = "/api/dsh-skillmanager/session";
const sessionOverrideRoute = "/api/dsh-skillmanager/session-override";
const sessionResetRoute = "/api/dsh-skillmanager/session-reset";
const sessionResetAllRoute = "/api/dsh-skillmanager/session-reset-all";

function note(file) { return join(vault1, "skills", file); }

// ---- 1. wiring ----
const paths = registered.map((r) => r.path);
for (const p of [stateRoute, configRoute, addRoute, importRoute, toggleRoute, updateRoute, removeRoute, openFolderRoute,
                 sessionRoute, sessionOverrideRoute, sessionResetRoute, sessionResetAllRoute]) {
  check("route " + p + " registered", paths.includes(p));
}
const section = sections.find((s) => s.name === "dsh-skillmanager-fixed-prompt");
check("systemPrompt section registered", !!section);
check("systemPrompt section starts empty", section && section.text() === "");
check("section text tolerates a context-less call", section && section.text(undefined) === "");

// A session-scoped call: the prompt provider reads the agent id out of the
// assembly context, so the same section can serve different conversations.
const inSession = (id) => section.text({ agent: { id }, scope: { id } });

// ---- 2. fresh state ----
const s0 = await call(stateRoute, {});
check("state reports default vaultDir", s0.vaultDir === vault1, s0.vaultDir);
check("state reports default skillsDir", s0.skillsDir === join(vault1, "skills"), s0.skillsDir);
check("state lists no skills initially", Array.isArray(s0.skills) && s0.skills.length === 0);

// ---- 3. add ----
const a1 = await call(addRoute, { name: "my-skill", content: "第一条规则", description: "当需要示例时使用" });
const add1 = a1.skills && a1.skills.find((x) => x.file === "my-skill.md");
check("add creates skill entry", !!add1, JSON.stringify(a1.skills));
check("add entry enabled by default", !!add1 && add1.enabled === true);
check("add entry carries description", !!add1 && add1.description === "当需要示例时使用");
check("add entry carries content", !!add1 && add1.content === "第一条规则");
const raw1 = readFileSync(note("my-skill.md"), "utf8");
check("note file has frontmatter", raw1.startsWith("---\n"), raw1.slice(0, 40));
check("note frontmatter has kebab name", /name: my-skill/.test(raw1), raw1);
check("note frontmatter enabled true", /enabled: true/.test(raw1), raw1);
const s1 = await call(stateRoute, {});
check("state lists exactly one skill", s1.skills.length === 1);

// ---- 4. duplicate add rejected ----
const dup = await call(addRoute, { name: "my-skill", content: "x" });
check("duplicate add rejected", dup.error === "already exists" || dup.ok === false, JSON.stringify(dup));

// ---- 5. toggle ----
const t1 = await call(toggleRoute, { file: "my-skill.md", enabled: false });
const toggled = t1.skills.find((x) => x.file === "my-skill.md");
check("toggle sets enabled false", toggled && toggled.enabled === false);
check("toggle rewrites frontmatter", /enabled: false/.test(readFileSync(note("my-skill.md"), "utf8")));

// ---- 6. update preserves enabled + unknown fields ----
// simulate an Obsidian edit: enable again and add a custom tag field
writeFileSync(
  note("my-skill.md"),
  "---\nname: my-skill\ndescription: 当需要示例时使用\nenabled: true\ntags: [规则, 示例]\n---\nObsidian 里改过的新内容\n",
  "utf8"
);
const u1 = await call(updateRoute, { file: "my-skill.md", content: "页面保存的正文" });
const updated = u1.skills.find((x) => x.file === "my-skill.md");
check("update replaces body", updated && updated.content === "页面保存的正文");
check("update keeps enabled from note", updated && updated.enabled === true);
const rawU = readFileSync(note("my-skill.md"), "utf8");
check("update preserves unknown frontmatter field", /tags: \[规则, 示例\]/.test(rawU), rawU);
check("update preserves description", updated && updated.description === "当需要示例时使用");

// ---- 7. injection text ----
check("enabled skill text injected", section.text() === "页面保存的正文", JSON.stringify(section.text()));
await call(toggleRoute, { file: "my-skill.md", enabled: false });
check("disabled skill not injected", section.text() === "");

// ---- 8. note without frontmatter defaults enabled ----
writeFileSync(note("plain.md"), "无 frontmatter 的笔记正文", "utf8");
const s8 = await call(stateRoute, {});
const plain = s8.skills.find((x) => x.file === "plain.md");
check("no-frontmatter note discovered", !!plain);
check("no-frontmatter note defaults enabled", plain && plain.enabled === true);
check("no-frontmatter note derives kebab name", plain && plain.name === "plain", plain && plain.name);
check("no-frontmatter note injected", section.text() === "无 frontmatter 的笔记正文", JSON.stringify(section.text()));

// ---- 9. import preserves an already-formatted note ----
const importedContent = "---\nname: imported-note\ndescription: 导入的标准笔记\nenabled: false\n---\n导入的正文\n";
const im = await call(importRoute, { file: "已导入笔记.md", content: importedContent });
const imported = im.skills.find((x) => x.file === "已导入笔记.md");
check("import keeps loose filename", !!imported, JSON.stringify(im.skills));
check("import preserves note frontmatter name", imported && imported.name === "imported-note");
check("import honors enabled:false", imported && imported.enabled === false);
check("import file content untouched", readFileSync(note("已导入笔记.md"), "utf8") === importedContent);
const im2 = await call(importRoute, { file: "plain-import.txt", content: "普通正文" });
const imp2 = im2.skills.find((x) => x.file === "plain-import.txt.md");
check("import without frontmatter wraps s.md", !!imp2);
check("import without frontmatter enabled", imp2 && imp2.enabled === true);

// ---- 10. remove ----
const rm = await call(removeRoute, { file: "plain.md" });
check("remove deletes skill", rm.skills.every((x) => x.file !== "plain.md"));
check("remove deletes file on disk", !existsSync(note("plain.md")));

// ---- 11. legacy name key still works ----
const toggleOld = await call(toggleRoute, { name: "my-skill.md", enabled: true });
check("legacy name key accepted by toggle", toggleOld.skills.find((x) => x.file === "my-skill.md").enabled === true);

// ---- 11b. toggle/update keep a custom frontmatter name ----
await call(toggleRoute, { file: "已导入笔记.md", enabled: true });
const tImp = await call(stateRoute, {});
check("toggle keeps imported note name", tImp.skills.find((x) => x.file === "已导入笔记.md").name === "imported-note");
const rawImpToggle = readFileSync(note("已导入笔记.md"), "utf8");
check("toggle keeps name line in file", /name: imported-note/.test(rawImpToggle), rawImpToggle);
await call(updateRoute, { file: "已导入笔记.md", content: "改过的导入正文" });
const rawImpUpdate = readFileSync(note("已导入笔记.md"), "utf8");
check("update keeps name line in file", /name: imported-note/.test(rawImpUpdate), rawImpUpdate);
check("update keeps enabled true after toggle", /enabled: true/.test(rawImpUpdate), rawImpUpdate);

// ---- 12. path traversal guards ----
const evil = await call(removeRoute, { file: "../../evil.md" });
check("traversal remove rejected", evil.error !== undefined && evil.ok !== true, JSON.stringify(evil));
const evilAdd = await call(addRoute, { name: "bad/name", content: "x" });
check("add with path char rejected", evilAdd.error !== undefined, JSON.stringify(evilAdd));

// ---- 12a. frontmatter with a UTF-8 BOM keeps its enabled flag ----
writeFileSync(note("bom.md"), "\uFEFF---\nname: bom\nenabled: false\n---\nBOM 笔记正文\n", "utf8");
const sBom = await call(stateRoute, {});
const bom = sBom.skills.find((x) => x.file === "bom.md");
check("BOM note frontmatter parsed", bom && bom.enabled === false, bom && bom.enabled);
check("BOM note not injected", !inSession("s-beta").includes("BOM 笔记正文"));

// ---- 12b. per-conversation overrides ----
// A note that is OFF in the settings page (the global default) but present in
// the folder: the conversation layer is what can switch it on.
writeFileSync(
  note("gated.md"),
  "---\nname: gated\ndescription: 默认停用的技能\nenabled: false\n---\n只在本对话启用的内容\n",
  "utf8"
);

const sv0 = await call(sessionRoute, { sessionId: "s-alpha" });
check("session view lists skills", Array.isArray(sv0.skills) && sv0.skills.length >= 1, JSON.stringify(sv0).slice(0, 160));
const gated0 = sv0.skills.find((x) => x.file === "gated.md");
check("session view reports the default as disabled", gated0 && gated0.defaultEnabled === false);
check("session view starts with no override", gated0 && gated0.override === null);
check("session view does not ship note bodies", gated0 && gated0.content === undefined);
check("default-off skill is not injected", !inSession("s-alpha").includes("只在本对话启用的内容"));

const svOn = await call(sessionOverrideRoute, { sessionId: "s-alpha", file: "gated.md", enabled: true });
const gated1 = svOn.skills.find((x) => x.file === "gated.md");
check("override switches a default-off skill on", gated1 && gated1.override === true && gated1.effective === true);
check("overridden skill is injected in that conversation", inSession("s-alpha").includes("只在本对话启用的内容"));
check("another conversation is unaffected", !inSession("s-beta").includes("只在本对话启用的内容"));
check("the note on disk is untouched", /enabled: false/.test(readFileSync(note("gated.md"), "utf8")));

const svOff = await call(sessionOverrideRoute, { sessionId: "s-alpha", file: "my-skill.md", enabled: false });
check("override switches a default-on skill off", svOff.skills.find((x) => x.file === "my-skill.md").effective === false);
check("that conversation drops the default skill", !inSession("s-alpha").includes("页面保存的正文"));
check("another conversation keeps the default skill", inSession("s-beta").includes("页面保存的正文"));

// subagent inheritance: sub-1's parent is s-alpha (see the mock session store)
const svSub = await call(sessionRoute, { sessionId: "sub-1" });
const gatedSub = svSub.skills.find((x) => x.file === "gated.md");
check("subagent inherits the parent override", gatedSub && gatedSub.effective === true && gatedSub.override === true);
check("subagent view flags where the override came from", gatedSub && gatedSub.inheritedFrom === "s-alpha", gatedSub && gatedSub.inheritedFrom);
check("subagent prompt carries the inherited skill", inSession("sub-1").includes("只在本对话启用的内容"));
check("session view records the chain", svSub.chain[0] === "sub-1" && svSub.chain[1] === "s-alpha", JSON.stringify(svSub.chain));

// persistence
check("overrides file written", existsSync(overridesFile));
const rawOv = JSON.parse(readFileSync(overridesFile, "utf8"));
check(
  "overrides file is keyed by session id",
  Array.isArray(rawOv.sessions) && rawOv.sessions.some((s) => s.id === "s-alpha" && s.skills["gated.md"] === true),
  JSON.stringify(rawOv).slice(0, 200)
);
check("overrides file is versioned", rawOv.version === 1);

// clearing one skill falls back to the settings default
const svClearOne = await call(sessionOverrideRoute, { sessionId: "s-alpha", file: "gated.md", enabled: null });
check("null clears a single override", svClearOne.skills.find((x) => x.file === "gated.md").override === null);
check("cleared skill follows the default again", !inSession("s-alpha").includes("只在本对话启用的内容"));

// clearing a whole conversation
const svReset = await call(sessionResetRoute, { sessionId: "s-alpha" });
check("session reset clears every override", svReset.overrideCount === 0, svReset.overrideCount);
check("session reset restores the default skill", inSession("s-alpha").includes("页面保存的正文"));

// validation
const badSess = await call(sessionRoute, {});
check("session route requires an id", badSess.error !== undefined, JSON.stringify(badSess));
const badFile = await call(sessionOverrideRoute, { sessionId: "s-alpha", file: "missing.md", enabled: true });
check("override rejects an unknown skill", badFile.error !== undefined, JSON.stringify(badFile));
const protoSess = await call(sessionOverrideRoute, { sessionId: "__proto__", file: "gated.md", enabled: true });
check("override rejects a prototype-ish session id", protoSess.error !== undefined, JSON.stringify(protoSess));

// settings page sees the aggregate and can clear it
await call(sessionOverrideRoute, { sessionId: "s-one", file: "gated.md", enabled: true });
await call(sessionOverrideRoute, { sessionId: "s-two", file: "gated.md", enabled: true });
const stAgg = await call(stateRoute, {});
check("state reports how many conversations carry overrides", stAgg.sessionOverrideCount === 2, stAgg.sessionOverrideCount);
check("state lists those conversations", Array.isArray(stAgg.sessionOverrides) && stAgg.sessionOverrides.length === 2);
const clearedAll = await call(sessionResetAllRoute, {});
check("reset-all clears every conversation", clearedAll.sessionOverrideCount === 0 && clearedAll.cleared === 2, JSON.stringify(clearedAll.cleared));
check("reset-all restores the settings default", !inSession("s-one").includes("只在本对话启用的内容"));

// ---- 13. pointer redirect ----
mkdirSync(join(vault2, "skills"), { recursive: true });
const cfg1 = await call(configRoute, { vaultDir: vault2 });
check("config switches vaultDir", cfg1.vaultDir === vault2, cfg1.vaultDir);
check("config switches skillsDir", cfg1.skillsDir === join(vault2, "skills"));
const a2 = await call(addRoute, { name: "second", content: "第二个仓库的技能" });
check("add works after redirect", a2.skills.length === 1 && a2.skills[0].file === "second.md");
check("old vault untouched by new writes", !existsSync(join(vault1, "skills", "second.md")));
const badCfg = await call(configRoute, { vaultDir: "" });
check("empty vaultDir rejected", badCfg.error !== undefined, JSON.stringify(badCfg));

// ---- 14. open-folder is wired (registration only; invocation opens Explorer) ----
check("open-folder route registered", registered.some((r) => r.path === openFolderRoute));

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(scratch, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
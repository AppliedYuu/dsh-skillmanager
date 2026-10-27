// dsh-skillmanager — host half.
//
// Manages custom fixed-prompt "skill" files whose real home is an Obsidian
// vault folder. Each skill is one Markdown note inside the vault; the note's
// YAML frontmatter declares `name`, `description` and `enabled`, and the body
// is the prompt text injected into every model request (via a `systemPrompt`
// section) while the skill is enabled.
//
// Two layers decide whether a skill is injected:
//
//   1. the settings page (this note's `enabled` frontmatter) — the GLOBAL
//      default, applied to every conversation;
//   2. a PER-CONVERSATION override stored here in a small JSON file — a
//      conversation may switch a skill on that is off by default, or switch a
//      default skill off, without touching the note or the settings page.
//
// The override layer is keyed by session id (the id of the conversation's
// agent/session, read from the prompt-assembly context). A session without an
// override entry simply follows the settings page. Subagent sessions fall back
// to their ancestor's overrides, so one conversation's choices cover the
// delegates it spawns.
//
// Storage layout (default, changeable from the settings page):
//   <vaultDir>/skills/                    <- the "skill folder" the UI can open
//     *.md                                <- one Markdown note per skill
//   ~/.dsh-skillmanager/config.json       <- { vaultDir: "E:\\dsh\\DSH-Memory" }
//   ~/.dsh-skillmanager/sessions.json     <- { version, sessions: [{ id, updatedAt, skills }] }
//
// Discovery is folder-native: every `*.md` file found in <vaultDir>/skills/ is
// a skill, so dropping a note into the folder inside Obsidian registers it
// automatically — no registry to sync. `enabled: true|false` in the note's
// frontmatter controls injection; editing a note in Obsidian takes effect on
// the next model request without touching the UI.
//
// HTTP surface for the browser settings page:
//   GET  /api/dsh-skillmanager/state    -> { vaultDir, skillsDir, defaultVaultDir,
//                                            sessionOverrideCount, sessionOverrides,
//                                            skills: [{file,name,description,enabled,
//                                                      contentLength,content}] }
//   POST /api/dsh-skillmanager/config   -> body { vaultDir }   (change the pointer)
//   POST /api/dsh-skillmanager/add      -> body { name, content, description? }
//   POST /api/dsh-skillmanager/import   -> body { file, content } (md import, loose name)
//   POST /api/dsh-skillmanager/update   -> body { file, content, description? }
//   POST /api/dsh-skillmanager/toggle   -> body { file, enabled }
//   POST /api/dsh-skillmanager/remove   -> body { file }
//   POST /api/dsh-skillmanager/open-folder -> opens the skill folder in the OS file manager
//
// HTTP surface for one conversation (the composer-side panel):
//   POST /api/dsh-skillmanager/session          -> body { sessionId }
//        -> { sessionId, chain, defaultCount, effectiveCount, overrideCount,
//             skills: [{file,name,description,contentLength,defaultEnabled,
//                       override, effective, inheritedFrom}] }
//   POST /api/dsh-skillmanager/session-override -> body { sessionId, file, enabled }
//        `enabled: null` clears that skill's override (back to the settings page)
//   POST /api/dsh-skillmanager/session-reset    -> body { sessionId }  (clear all of one conversation)
//   POST /api/dsh-skillmanager/session-reset-all-> clears every conversation's overrides
//
// Routes accept `{ name }` (legacy key) as well as `{ file }` so old clients
// keep working. Skill names in the list are the note filenames (without .md).

import { homedir } from "node:os";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  renameSync,
  readdirSync,
  statSync,
  copyFileSync,
  rmSync
} from "node:fs";
import { spawn } from "node:child_process";

export const name = "dsh-skillmanager";

/** Services this plugin needs before its apply runs. */
export const inject = ["systemPrompt", "webServer"];

// Plugin root = directory containing `lib/` (i.e. <repo>/), derived from this
// file. Only used as a migration safety net for very old installs that kept
// their skills inside the plugin repo itself.
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Pointer config lives outside the vault so it can be found before the vault
// is known. Defaults can be overridden through the environment (used by tests).
const DEFAULT_VAULT_DIR =
  process.env.DSH_SKILLMANAGER_DEFAULT_VAULT || "E:\\dsh\\DSH-Memory";
const CONFIG_FILE =
  process.env.DSH_SKILLMANAGER_CONFIG ||
  join(homedir(), ".dsh-skillmanager", "config.json");
const CONFIG_DIR = dirname(CONFIG_FILE);
const SKILLS_SUBDIR = "skills";

// Per-conversation overrides: one JSON file beside the pointer config. It only
// holds explicit per-session decisions, so deleting it loses nothing but those
// overrides (every conversation falls back to the settings page's defaults).
const OVERRIDES_FILE =
  process.env.DSH_SKILLMANAGER_OVERRIDES ||
  join(homedir(), ".dsh-skillmanager", "sessions.json");
// Session ids are cheap and conversations are many: keep the most recently
// touched N and drop the rest (the file is a preference cache, not history).
const OVERRIDES_SESSION_LIMIT = 300;
// How far up the parent-session chain one override lookup may reach.
const OVERRIDES_CHAIN_LIMIT = 8;

// Legacy locations, only scanned once to migrate older installs into the vault.
const LEGACY_STATE_FILE = join(homedir(), ".dsh-skillmanager.json");
const OLD_SKILL_DIR = join(homedir(), ".dsh-skillmanager");
const PLUGIN_LOCAL_SKILL_DIR = join(PLUGIN_ROOT, "skills");

const PREFIX = "/api/dsh-skillmanager";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

// DSH's standard skill-name grammar (kebab-case).
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Frontmatter keys this plugin manages; every other field is preserved as-is.
const MANAGED_FIELDS = new Set(["name", "description", "enabled", "whenToUse"]);

// ---------------------------------------------------------------------------
// configuration (the vault pointer)
// ---------------------------------------------------------------------------
const config = loadConfig();

function loadConfig() {
  let vaultDir = DEFAULT_VAULT_DIR;
  try {
    if (existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
      if (parsed && typeof parsed.vaultDir === "string" && parsed.vaultDir.trim()) {
        vaultDir = parsed.vaultDir.trim();
      }
    }
  } catch {
    /* broken config file -> fall back to default */
  }
  return { vaultDir: normalizeVaultDir(vaultDir) };
}

function saveConfig() {
  try {
    ensureDir(CONFIG_DIR);
    writeFileSync(CONFIG_FILE, JSON.stringify({ vaultDir: config.vaultDir }, null, 2), "utf8");
  } catch (e) {
    console.error("dsh-skillmanager: failed to save config", e);
  }
}

// Expand a leading "~" and make the path absolute so it works everywhere.
function normalizeVaultDir(raw) {
  let value = String(raw || "").trim();
  if (!value) return DEFAULT_VAULT_DIR;
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    value = join(homedir(), value.slice(1));
  }
  value = value.replace(/[\\/]+$/, "");
  return isAbsolute(value) ? resolve(value) : resolve(value);
}

function skillsDir() {
  return join(config.vaultDir, SKILLS_SUBDIR);
}

// ---------------------------------------------------------------------------
// filesystem helpers
// ---------------------------------------------------------------------------
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function listSkillFiles(dir) {
  ensureDir(dir);
  try {
    return readdirSync(dir, { encoding: "utf8" })
      .filter((f) => /\.md$/i.test(f))
      .filter((f) => statSync(join(dir, f)).isFile())
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

// Join a user-supplied basename onto the skills dir, refusing anything that
// could escape the folder (path separators, "..", absolute paths).
function resolveSkillFile(file) {
  const value = String(file || "").trim();
  if (!value || value === "." || value === "..") return null;
  if (/[\\/]/.test(value) || isAbsolute(value) || value.includes("..")) return null;
  if (!/\.md$/i.test(value)) return null;
  return join(skillsDir(), value);
}

function displayName(file) {
  return String(file).replace(/\.md$/i, "");
}

// Map a kebab-ish display name to a filesystem-safe note filename.
function safeFileName(name) {
  const cleaned = String(name || "")
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned || "skill") + ".md";
}

// Derive a DSH-standard kebab-case skill name from a note filename.
function deriveName(file) {
  const base = displayName(file) || "skill";
  const kebab = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab || "skill";
}

// ---------------------------------------------------------------------------
// frontmatter parsing / writing (small YAML subset, Obsidian-tolerant)
// ---------------------------------------------------------------------------
function parseFrontmatter(raw) {
  // Strip a UTF-8 BOM: some editors (and Windows note tools) write one, which
  // makes the first line "\uFEFF---". The strict comparison below would then
  // fail, the note would look frontmatter-less, and `enabled: false` would be
  // silently ignored (defaulting to injected).
  if (typeof raw === "string" && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const firstEnd = raw.indexOf("\n");
  if (firstEnd < 0 || raw.slice(0, firstEnd).replace(/\r$/, "") !== "---") return null;
  const start = firstEnd + 1;
  const closing = findClosingFrontmatter(raw, start);
  if (closing === undefined) return null;
  const lines = raw.slice(start, closing).split(/\r?\n/);
  const data = {};
  for (const line of lines) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    data[m[1]] = parseScalar(m[2]);
  }
  return {
    data,
    body: raw.slice(closing + 4),
    fmLines: lines
  };
}

function findClosingFrontmatter(raw, start) {
  let lineStart = start;
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf("\n", lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") return lineStart;
    if (nextNewline < 0) return undefined;
    lineStart = nextNewline + 1;
  }
  return undefined;
}

function parseScalar(value) {
  const v = String(value).trim();
  if (v === "") return "";
  if (v.startsWith('"') || v.startsWith("'")) return v.slice(1, -1);
  const lower = v.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "on") return true;
  if (lower === "false" || lower === "no" || lower === "off") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseBool(value) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === 0 || value === "0" || value === "false" || value === "no" || value === "off") return false;
  return undefined;
}

// Quote a frontmatter value only when YAML would otherwise misread it.
function yamlQuote(value) {
  const s = String(value ?? "");
  if (/^[\w\u4e00-\u9fff-]+$/.test(s) || s === "") return s;
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// Read one skill note from disk. Returns null when the file is gone.
function readSkillFile(file) {
  const path = resolveSkillFile(file);
  if (!path || !existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = parseFrontmatter(raw);
  const fm = parsed ? parsed.data : {};
  const body = parsed ? parsed.body : raw;
  const name =
    typeof fm.name === "string" && SKILL_NAME_RE.test(fm.name.trim())
      ? fm.name.trim()
      : deriveName(file);
  const description = typeof fm.description === "string" ? fm.description : "";
  const enabled = parseBool(fm.enabled) ?? true;
  return {
    file,
    displayName: displayName(file),
    name,
    description,
    enabled,
    contentLength: body.length,
    content: body,
    whenToUse: typeof fm.whenToUse === "string" ? fm.whenToUse : undefined
  };
}

// Write (or rewrite) one skill note. `patch` may contain any of name,
// description, enabled, whenToUse, body. Managed fields not present in the
// patch keep their existing frontmatter values; unknown frontmatter fields
// present in the existing note (tags, aliases, ...) are preserved as well.
function writeSkillFile(file, patch) {
  const path = resolveSkillFile(file);
  if (!path) throw new Error("invalid file name");
  ensureDir(skillsDir());
  const prev = existsSync(path) ? parseFrontmatter(readFileSync(path, "utf8")) : null;
  const prevData = prev ? prev.data : {};

  const name =
    patch.name !== undefined
      ? patch.name
      : typeof prevData.name === "string"
        ? prevData.name
        : undefined;
  const description =
    patch.description !== undefined
      ? patch.description
      : typeof prevData.description === "string"
        ? prevData.description
        : undefined;
  const enabled =
    patch.enabled !== undefined ? patch.enabled : parseBool(prevData.enabled);
  const whenToUse =
    patch.whenToUse !== undefined
      ? patch.whenToUse
      : typeof prevData.whenToUse === "string"
        ? prevData.whenToUse
        : undefined;

  const lines = [];
  if (name !== undefined && String(name).trim() !== "") lines.push(`name: ${yamlQuote(name)}`);
  if (description !== undefined && String(description).trim() !== "") {
    lines.push(`description: ${yamlQuote(description)}`);
  }
  if (whenToUse !== undefined && String(whenToUse).trim() !== "") {
    lines.push(`whenToUse: ${yamlQuote(whenToUse)}`);
  }
  if (enabled !== undefined) lines.push(`enabled: ${enabled ? "true" : "false"}`);
  if (prev) {
    for (const line of prev.fmLines) {
      const key = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
      if (key && MANAGED_FIELDS.has(key[1])) continue;
      lines.push(line);
    }
  }
  const body = String(patch.body ?? (prev ? prev.body : "")).replace(/^\s+/, "");
  const content = "---\n" + lines.join("\n") + "\n---\n" + body;
  writeFileSync(path, content, "utf8");
}

function removeSkillFile(file) {
  const path = resolveSkillFile(file);
  if (path && existsSync(path)) unlinkSync(path);
}

// ---------------------------------------------------------------------------
// legacy migrations (only fire once on old installs)
// ---------------------------------------------------------------------------
function migrateLegacy() {
  // Tests point the plugin at a scratch vault; keep the repo's own data out of
  // the picture unless the migration path itself is under test.
  if (process.env.DSH_SKILLMANAGER_SKIP_MIGRATE === "1") return;
  if (existsSync(LEGACY_STATE_FILE)) migrateLegacyStateFile();
  if (existsSync(OLD_SKILL_DIR) && OLD_SKILL_DIR !== CONFIG_DIR) migrateOldFolder();
  migratePluginLocalFolder();
}

// ~/.dsh-skillmanager.json  (version 0.0.x single-file store)
function migrateLegacyStateFile() {
  try {
    const parsed = JSON.parse(readFileSync(LEGACY_STATE_FILE, "utf8"));
    const legacy = (parsed && Array.isArray(parsed.skills) ? parsed.skills : []).filter(
      (s) => s && typeof s.name === "string"
    );
    if (!legacy.length) {
      unlinkSync(LEGACY_STATE_FILE);
      return;
    }
    for (const s of legacy) {
      const file = String(s.file || "").trim() || safeFileName(s.name);
      if (!/\.md$/i.test(file)) continue;
      try {
        writeSkillFile(file, {
          name: deriveName(file),
          description: s.description,
          enabled: s.enabled !== false,
          body: String(s.content || "")
        });
      } catch (e) {
        console.error("dsh-skillmanager: legacy migrate write failed", e);
      }
    }
    try {
      unlinkSync(LEGACY_STATE_FILE);
    } catch {
      /* keep legacy file if we cannot remove it */
    }
  } catch {
    /* ignore broken legacy file */
  }
}

// ~/.dsh-skillmanager/  (very old folder store; now the config dir)
function migrateOldFolder() {
  try {
    for (const entry of readdirSync(OLD_SKILL_DIR, { encoding: "utf8" })) {
      if (entry === "config.json") continue;
      const src = join(OLD_SKILL_DIR, entry);
      if (!statSync(src).isFile()) continue;
      const file = /\.md$/i.test(entry) ? entry : entry + ".md";
      try {
        writeSkillFile(file, {
          name: deriveName(file),
          enabled: true,
          body: readFileSync(src, "utf8")
        });
        unlinkSync(src);
      } catch (e) {
        console.error("dsh-skillmanager: old folder migrate failed", e);
      }
    }
  } catch {
    /* ignore */
  }
}

// <plugin-root>/skills/registry.json  (in-repo store shipped before the vault
// switch; only present when the plugin runs from the repo checkout). Runs at
// most once: the legacy registry is renamed afterwards so later restarts never
// clobber vault-side edits to the migrated notes.
function migratePluginLocalFolder() {
  const registryFile = join(PLUGIN_LOCAL_SKILL_DIR, "registry.json");
  if (!existsSync(registryFile)) return;
  let migrated = 0;
  try {
    const parsed = JSON.parse(readFileSync(registryFile, "utf8"));
    const skills = (parsed && Array.isArray(parsed.skills) ? parsed.skills : []).filter(
      (s) => s && typeof s.name === "string"
    );
    for (const s of skills) {
      const file = String(s.file || "").trim() || safeFileName(s.name);
      if (!/\.md$/i.test(file)) continue;
      const src = join(PLUGIN_LOCAL_SKILL_DIR, file);
      if (!existsSync(src)) continue;
      try {
        writeSkillFile(file, {
          name: deriveName(file),
          enabled: s.enabled !== false,
          body: readFileSync(src, "utf8")
        });
        migrated += 1;
      } catch (e) {
        console.error("dsh-skillmanager: plugin-local migrate failed", e);
      }
    }
  } catch {
    /* ignore */
  }
  if (migrated > 0) {
    try {
      renameSync(registryFile, registryFile + ".migrated");
    } catch {
      /* keep the registry file if we cannot rename it */
    }
  }
}

// ---------------------------------------------------------------------------
// per-conversation overrides (the "this conversation only" layer)
// ---------------------------------------------------------------------------
// `runtime.ctx` is the plugin's own context, kept so the prompt provider can
// reach `ctx.sessions` lazily — that service comes from dsh-session, which this
// plugin must NOT hard-depend on (a host without it simply loses parent-session
// inheritance and keeps working).
const runtime = { ctx: null };
const overrides = loadOverrides();

function isSafeSessionId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 200) return false;
  if (/[\x00-\x1f\x7f]/.test(id)) return false;
  if (id === "__proto__" || id === "constructor" || id === "prototype") return false;
  return true;
}

function sanitizeSessionId(value) {
  return isSafeSessionId(value) ? String(value).trim() : "";
}

function loadOverrides() {
  const map = new Map();
  try {
    if (!existsSync(OVERRIDES_FILE)) return map;
    const parsed = JSON.parse(readFileSync(OVERRIDES_FILE, "utf8"));
    const list = parsed && Array.isArray(parsed.sessions) ? parsed.sessions : [];
    for (const entry of list) {
      const id = entry && typeof entry.id === "string" ? entry.id.trim() : "";
      if (!isSafeSessionId(id)) continue;
      const skills = {};
      const source = entry && entry.skills && typeof entry.skills === "object" ? entry.skills : {};
      for (const file of Object.keys(source)) {
        if (!/\.md$/i.test(file)) continue;
        if (typeof source[file] === "boolean") skills[file] = source[file];
      }
      if (!Object.keys(skills).length) continue;
      map.set(id, { updatedAt: Number(entry.updatedAt) || 0, skills });
    }
  } catch {
    /* a broken overrides file only costs the overrides themselves */
  }
  return map;
}

function saveOverrides() {
  try {
    ensureDir(dirname(OVERRIDES_FILE));
    while (overrides.size > OVERRIDES_SESSION_LIMIT) {
      let oldestId;
      let oldestAt = Infinity;
      for (const [id, entry] of overrides) {
        if (entry.updatedAt < oldestAt) {
          oldestAt = entry.updatedAt;
          oldestId = id;
        }
      }
      if (oldestId === undefined) break;
      overrides.delete(oldestId);
    }
    const sessions = Array.from(overrides.entries())
      .map(([id, entry]) => ({ id, updatedAt: entry.updatedAt, skills: entry.skills }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const tmp = OVERRIDES_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions }, null, 2), "utf8");
    renameSync(tmp, OVERRIDES_FILE);
  } catch (e) {
    console.error("dsh-skillmanager: failed to save per-conversation overrides", e);
  }
}

function sessionsService() {
  const ctx = runtime.ctx;
  if (!ctx || typeof ctx.get !== "function") return undefined;
  try {
    return ctx.get("sessions");
  } catch {
    return undefined;
  }
}

// The session id behind one prompt assembly: the agent being assembled carries
// it (`{ agent, scope: agent }`), and older hosts only tag the scope.
function sessionIdOf(context) {
  const agent = context && context.agent;
  if (agent && typeof agent.id === "string" && agent.id) return agent.id;
  const scope = context && context.scope;
  if (scope && typeof scope.id === "string" && scope.id) return scope.id;
  return undefined;
}

// Override lookup order for one conversation: its own decisions first, then the
// conversation it was delegated or forked from (subagents inherit the parent's
// choices), nearest ancestor first.
function overrideChain(sessionId) {
  const chain = [];
  const seen = new Set();
  let id = typeof sessionId === "string" ? sessionId.trim() : "";
  while (id && !seen.has(id) && chain.length < OVERRIDES_CHAIN_LIMIT) {
    seen.add(id);
    chain.push(id);
    let parent = "";
    try {
      const sessions = sessionsService();
      const session =
        sessions && typeof sessions.get === "function" ? sessions.get(id) : undefined;
      const candidate = session && session.header ? session.header.parentSession : undefined;
      parent = typeof candidate === "string" ? candidate.trim() : "";
    } catch {
      parent = "";
    }
    id = parent;
  }
  return chain;
}

function overrideFor(chain, file) {
  for (const id of chain) {
    const entry = overrides.get(id);
    if (!entry || !Object.prototype.hasOwnProperty.call(entry.skills, file)) continue;
    return { enabled: !!entry.skills[file], sessionId: id };
  }
  return null;
}

// Every skill with both layers resolved for one conversation. A null `override`
// means "no decision in this conversation — follow the settings page".
function resolvedSkills(sessionId, chain) {
  const lookup = Array.isArray(chain) ? chain : overrideChain(sessionId);
  const own = lookup[0];
  return listSkillFiles(skillsDir())
    .map((f) => readSkillFile(f))
    .filter(Boolean)
    .map((s) => {
      const hit = overrideFor(lookup, s.file);
      const override = hit ? hit.enabled : null;
      return {
        file: s.file,
        displayName: s.displayName,
        name: s.name,
        description: s.description,
        contentLength: s.contentLength,
        defaultEnabled: s.enabled,
        override,
        effective: override === null ? s.enabled : override,
        inheritedFrom: hit && hit.sessionId !== own ? hit.sessionId : undefined,
        content: s.content
      };
    });
}

function setSessionOverride(sessionId, file, enabled) {
  const id = String(sessionId).trim();
  const entry = overrides.get(id) || { updatedAt: 0, skills: {} };
  const skills = Object.assign({}, entry.skills);
  if (enabled === null) delete skills[file];
  else skills[file] = !!enabled;
  if (Object.keys(skills).length === 0) overrides.delete(id);
  else overrides.set(id, { updatedAt: Date.now(), skills });
  saveOverrides();
}

function clearSessionOverrides(sessionId) {
  const cleared = overrides.delete(String(sessionId).trim());
  if (cleared) saveOverrides();
  return cleared;
}

function clearAllSessionOverrides() {
  const cleared = overrides.size;
  if (cleared) {
    overrides.clear();
    saveOverrides();
  }
  return cleared;
}

function sessionOverridesView() {
  return Array.from(overrides.entries())
    .map(([id, entry]) => ({
      sessionId: id,
      count: Object.keys(entry.skills).length,
      updatedAt: entry.updatedAt
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 50);
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------
function stateView() {
  const dir = skillsDir();
  const skills = listSkillFiles(dir)
    .map((f) => readSkillFile(f))
    .filter(Boolean)
    .map((s) => ({
      file: s.file,
      displayName: s.displayName,
      name: s.name,
      description: s.description,
      enabled: s.enabled,
      contentLength: s.contentLength,
      content: s.content
    }));
  return {
    vaultDir: config.vaultDir,
    skillsDir: dir,
    defaultVaultDir: DEFAULT_VAULT_DIR,
    sessionOverrideCount: overrides.size,
    sessionOverrides: sessionOverridesView(),
    skills
  };
}

function sessionView(sessionId) {
  const chain = overrideChain(sessionId);
  const skills = resolvedSkills(sessionId, chain).map((s) => ({
    file: s.file,
    displayName: s.displayName,
    name: s.name,
    description: s.description,
    contentLength: s.contentLength,
    defaultEnabled: s.defaultEnabled,
    override: s.override,
    effective: s.effective,
    inheritedFrom: s.inheritedFrom
  }));
  return {
    sessionId,
    chain,
    skills,
    defaultCount: skills.filter((s) => s.defaultEnabled).length,
    effectiveCount: skills.filter((s) => s.effective).length,
    overrideCount: skills.filter((s) => s.override !== null).length
  };
}

// The prompt text for one conversation: the settings page's defaults, with that
// conversation's own switches applied on top.
function activePromptText(sessionId) {
  const parts = [];
  for (const s of resolvedSkills(sessionId)) {
    if (!s.effective) continue;
    const content = String(s.content || "").trim();
    if (content) parts.push(content);
  }
  return parts.join("\n\n");
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > 1_000_000) break;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

// Accept either the new `file` key or the legacy `name` key as the target.
function skillFileKey(body) {
  const file = body && typeof body.file === "string" && body.file.trim() ? body.file.trim() : "";
  if (file) return file;
  const legacy = body && typeof body.name === "string" && body.name.trim() ? body.name.trim() : "";
  if (legacy) return /\.md$/i.test(legacy) ? legacy : legacy + ".md";
  return "";
}

// ---------------------------------------------------------------------------
// plugin body
// ---------------------------------------------------------------------------
export function apply(ctx) {
  // One-time migration of very old installs into the current vault layout.
  migrateLegacy();

  // Keep the context for lazy service lookups (see sessionsService()).
  runtime.ctx = ctx;

  // Inject the enabled skills' content into every model request's system prompt.
  // The provider runs per assembly, so it resolves the per-conversation layer for
  // whichever session is being assembled.
  const systemPrompt = ctx.get("systemPrompt");
  if (systemPrompt) {
    ctx.effect(
      () =>
        systemPrompt.section({
          name: "dsh-skillmanager-fixed-prompt",
          order: 150,
          text: (context) => activePromptText(sessionIdOf(context))
        }),
      "dsh-skillmanager:system-prompt-section"
    );
  }

  const webServer = ctx.get("webServer");
  if (!webServer) return;

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: `${PREFIX}/state`,
        handler: async (_req, res) => sendJson(res, 200, stateView())
      }),
    "dsh-skillmanager:state"
  );

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: `${PREFIX}/config`,
        handler: async (req, res) => {
          const body = await readBody(req);
          const raw = body && typeof body.vaultDir === "string" ? body.vaultDir : "";
          if (!raw.trim()) return sendJson(res, 400, { ok: false, error: "vaultDir is required" });
          try {
            const next = normalizeVaultDir(raw);
            ensureDir(join(next, SKILLS_SUBDIR));
            config.vaultDir = next;
            saveConfig();
            sendJson(res, 200, stateView());
          } catch (e) {
            sendJson(res, 400, {
              ok: false,
              error: "cannot use this directory: " + (e && e.message ? e.message : e)
            });
          }
        }
      }),
    "dsh-skillmanager:config"
  );

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: `${PREFIX}/toggle`,
        handler: async (req, res) => {
          const body = await readBody(req);
          const file = skillFileKey(body);
          if (!existsSync(resolveSkillFile(file) || "")) {
            return sendJson(res, 404, { ok: false, error: "skill not found" });
          }
          try {
            writeSkillFile(file, { enabled: !!(body && body.enabled) });
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: "write failed" });
          }
          sendJson(res, 200, stateView());
        }
      }),
    "dsh-skillmanager:toggle"
  );

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: `${PREFIX}/add`,
        handler: async (req, res) => {
          const body = await readBody(req);
          const name = sanitizeName(body && body.name);
          if (!name) return sendJson(res, 400, { ok: false, error: "invalid name" });
          const file = safeFileName(name);
          if (existsSync(resolveSkillFile(file) || "")) {
            return sendJson(res, 409, { ok: false, error: "already exists" });
          }
          const desc = body && typeof body.description === "string" ? body.description.trim() : "";
          try {
            writeSkillFile(file, {
              name: deriveName(file),
              ...(desc ? { description: desc } : {}),
              enabled: true,
              body: body && body.content
            });
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: "write failed" });
          }
          sendJson(res, 200, stateView());
        }
      }),
    "dsh-skillmanager:add"
  );

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: `${PREFIX}/import`,
        handler: async (req, res) => {
          const body = await readBody(req);
          const file = sanitizeImportName(body && body.file ? body.file : body && body.name);
          if (!file) return sendJson(res, 400, { ok: false, error: "invalid name" });
          const fileName = /\.md$/i.test(file) ? file : file + ".md";
          const path = resolveSkillFile(fileName);
          if (!path || existsSync(path)) {
            return sendJson(res, 409, { ok: false, error: "already exists" });
          }
          try {
            const content = body && body.content !== undefined ? String(body.content) : "";
            const parsed = parseFrontmatter(content);
            if (parsed) {
              // The imported note already carries standard frontmatter
              // (name/description/enabled): keep the file exactly as-is.
              ensureDir(skillsDir());
              writeFileSync(path, content, "utf8");
            } else {
              const desc = body && typeof body.description === "string" ? body.description.trim() : "";
              writeSkillFile(fileName, {
                name: deriveName(fileName),
                ...(desc ? { description: desc } : {}),
                enabled: true,
                body: content
              });
            }
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: "write failed" });
          }
          sendJson(res, 200, stateView());
        }
      }),
    "dsh-skillmanager:import"
  );

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: `${PREFIX}/update`,
        handler: async (req, res) => {
          const body = await readBody(req);
          const file = skillFileKey(body);
          const path = resolveSkillFile(file);
          if (!path || !existsSync(path)) {
            return sendJson(res, 404, { ok: false, error: "skill not found" });
          }
          const current = readSkillFile(file);
          const desc =
            body && typeof body.description === "string" && body.description.trim()
              ? body.description.trim()
              : undefined;
          try {
            writeSkillFile(file, {
              description: desc !== undefined ? desc : undefined,
              body: body && typeof body.content === "string" ? body.content : current ? current.content : ""
            });
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: "write failed" });
          }
          sendJson(res, 200, stateView());
        }
      }),
    "dsh-skillmanager:update"
  );

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: `${PREFIX}/remove`,
        handler: async (req, res) => {
          const body = await readBody(req);
          const file = skillFileKey(body);
          const path = resolveSkillFile(file);
          if (!path || !existsSync(path)) {
            return sendJson(res, 404, { ok: false, error: "skill not found" });
          }
          try {
            removeSkillFile(file);
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: "remove failed" });
          }
          sendJson(res, 200, stateView());
        }
      }),
    "dsh-skillmanager:remove"
  );

  // -- per-conversation layer -------------------------------------------------
  // Read the resolved view for one conversation (its own choice, the settings
  // page default, and which layer won).
  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: `${PREFIX}/session`,
        handler: async (req, res) => {
          const body = await readBody(req);
          const sessionId = sanitizeSessionId(body && (body.sessionId || body.id || body.session));
          if (!sessionId) return sendJson(res, 400, { ok: false, error: "sessionId is required" });
          sendJson(res, 200, sessionView(sessionId));
        }
      }),
    "dsh-skillmanager:session"
  );

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: `${PREFIX}/session-override`,
        handler: async (req, res) => {
          const body = await readBody(req);
          const sessionId = sanitizeSessionId(body && (body.sessionId || body.id || body.session));
          if (!sessionId) return sendJson(res, 400, { ok: false, error: "sessionId is required" });
          const file = skillFileKey(body);
          const path = resolveSkillFile(file);
          if (!path || !existsSync(path)) {
            return sendJson(res, 404, { ok: false, error: "skill not found" });
          }
          // `enabled: null` (or a missing key) drops the override for this skill
          // so the conversation follows the settings page again.
          const raw = body ? body.enabled : undefined;
          const enabled = raw === null || raw === undefined ? null : !!raw;
          try {
            setSessionOverride(sessionId, file, enabled);
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: "write failed" });
          }
          sendJson(res, 200, sessionView(sessionId));
        }
      }),
    "dsh-skillmanager:session-override"
  );

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: `${PREFIX}/session-reset`,
        handler: async (req, res) => {
          const body = await readBody(req);
          const sessionId = sanitizeSessionId(body && (body.sessionId || body.id || body.session));
          if (!sessionId) return sendJson(res, 400, { ok: false, error: "sessionId is required" });
          try {
            clearSessionOverrides(sessionId);
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: "write failed" });
          }
          sendJson(res, 200, sessionView(sessionId));
        }
      }),
    "dsh-skillmanager:session-reset"
  );

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: `${PREFIX}/session-reset-all`,
        handler: async (_req, res) => {
          let cleared = 0;
          try {
            cleared = clearAllSessionOverrides();
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: "write failed" });
          }
          sendJson(res, 200, Object.assign(stateView(), { cleared }));
        }
      }),
    "dsh-skillmanager:session-reset-all"
  );

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: `${PREFIX}/open-folder`,
        handler: async (_req, res) => {
          const dir = skillsDir();
          try {
            ensureDir(dir);
          } catch {
            return sendJson(res, 500, { ok: false, error: "failed to prepare folder" });
          }
          try {
            // Open the folder in the OS file manager. `explorer.exe <dir>` with an
            // argv array lets Node quote the path correctly (spaces included), and
            // windowsHide MUST be false or Explorer's window never appears.
            const spawned = await new Promise((resolve, reject) => {
              const child = spawn("explorer.exe", [dir], {
                detached: true,
                stdio: "ignore",
                windowsHide: false
              });
              child.on("error", reject);
              child.on("spawn", () => resolve(child));
              child.unref();
            });
            spawned.unref();
            sendJson(res, 200, { ok: true, dir });
          } catch (e) {
            sendJson(res, 500, {
              ok: false,
              error: "failed to open folder: " + (e && e.message ? e.message : e)
            });
          }
        }
      }),
    "dsh-skillmanager:open-folder"
  );
}

// ---------------------------------------------------------------------------
// validation helpers
// ---------------------------------------------------------------------------
function sanitizeName(name) {
  const n = String(name || "").trim();
  return SKILL_NAME_RE.test(n) ? n : null;
}

// Loose validation for imported files: allow letters/digits/unicode/space/dash/
// underscore/dot (incl. ".md"), reject anything that would break a filename on
// common platforms (path separators, Windows-reserved chars, control chars).
function sanitizeImportName(name) {
  const n = String(name || "").trim();
  if (!n || n.length > 120) return null;
  if (/[\\/:*?"<>|\x00-\x1f\x7f]/.test(n)) return null;
  return n;
}
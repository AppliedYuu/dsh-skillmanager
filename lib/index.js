// dsh-skillmanager — host half.
//
// Manages custom fixed-prompt "skill" files that are auto-injected into every
// model request (via a `systemPrompt` section), with a durable registry file
// on disk and an HTTP surface for the browser settings page:
//   GET  /api/dsh-skillmanager/state -> { enabled, skills: [{name,enabled,contentLength}] }
//   POST /api/dsh-skillmanager/power  -> body { enabled }
//   POST /api/dsh-skillmanager/add    -> body { name, content }
//   POST /api/dsh-skillmanager/remove -> body { name }
//   POST /api/dsh-skillmanager/toggle -> body { name, enabled }
//
// The registry is persisted as JSON at <homedir>/.dsh-skillmanager.json so it
// survives process restarts.

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const name = "dsh-skillmanager";

/** Services this plugin needs before its apply runs. */
export const inject = ["systemPrompt", "webServer"];

const STATE_FILE = join(homedir(), ".dsh-skillmanager.json");

const PREFIX = "/api/dsh-skillmanager";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

// ---------------------------------------------------------------------------
// durable registry
// ---------------------------------------------------------------------------
const state = { enabled: true, skills: [] };

function loadRegistry() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (parsed && Array.isArray(parsed.skills)) {
      state.enabled = parsed.enabled !== false;
      state.skills = parsed.skills
        .filter((s) => s && typeof s.name === "string")
        .map((s) => ({
          name: s.name,
          enabled: s.enabled !== false,
          content: String(s.content || "")
        }));
    }
  } catch {
    /* first run: no registry yet */
  }
}

function persist() {
  try {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ enabled: state.enabled, skills: state.skills }, null, 2),
      "utf8"
    );
  } catch (e) {
    console.error("dsh-skillmanager: persist failed", e);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function findSkill(name) {
  for (const s of state.skills) if (s.name === name) return s;
  return undefined;
}

function sanitizeName(name) {
  const n = String(name || "").trim();
  return /^[a-z0-9][a-z0-9-]*$/.test(n) ? n : null;
}

function stateView() {
  return {
    enabled: state.enabled,
    skills: state.skills.map((s) => ({
      name: s.name,
      enabled: s.enabled,
      contentLength: s.content.length
    }))
  };
}

function activePromptText() {
  if (!state.enabled) return "";
  return state.skills
    .filter((s) => s.enabled)
    .map((s) => s.content)
    .filter((c) => c && c.trim())
    .join("\n\n");
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

// ---------------------------------------------------------------------------
// plugin body
// ---------------------------------------------------------------------------
export function apply(ctx) {
  // Load the durable registry at startup.
  loadRegistry();

  // Inject the enabled skills' content into every model request's system prompt.
  const systemPrompt = ctx.get("systemPrompt");
  if (systemPrompt) {
    ctx.effect(() =>
      systemPrompt.section({
        name: "dsh-skillmanager-fixed-prompt",
        order: 150,
        text: () => activePromptText()
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
        path: `${PREFIX}/power`,
        handler: async (req, res) => {
          const body = await readBody(req);
          state.enabled = !!(body && body.enabled);
          persist();
          sendJson(res, 200, stateView());
        }
      }),
    "dsh-skillmanager:power"
  );

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: `${PREFIX}/toggle`,
        handler: async (req, res) => {
          const body = await readBody(req);
          const s = body && findSkill(body.name);
          if (!s) return sendJson(res, 404, { ok: false, error: "skill not found" });
          s.enabled = !!(body.enabled);
          persist();
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
          if (findSkill(name)) return sendJson(res, 409, { ok: false, error: "already exists" });
          state.skills.push({
            name,
            enabled: true,
            content: String((body && body.content) || "")
          });
          persist();
          sendJson(res, 200, stateView());
        }
      }),
    "dsh-skillmanager:add"
  );

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: `${PREFIX}/remove`,
        handler: async (req, res) => {
          const body = await readBody(req);
          const idx = state.skills.findIndex((s) => s.name === (body && body.name));
          if (idx === -1) return sendJson(res, 404, { ok: false, error: "skill not found" });
          state.skills.splice(idx, 1);
          persist();
          sendJson(res, 200, stateView());
        }
      }),
    "dsh-skillmanager:remove"
  );
}

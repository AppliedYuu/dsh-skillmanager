// dsh-skillmanager — client (browser) half.
//
// Registers:
//   1. an additive "固定提示词" settings page backed by an Obsidian vault folder.
//      Each skill is a Markdown note inside <vaultDir>/skills/ with YAML
//      frontmatter (`name`, `description`, `enabled`); the page can read,
//      preview, edit, toggle, create, import and delete those notes, change the
//      vault pointer, and open the folder in the OS file manager. The toggle on
//      this page is the GLOBAL default: it applies to every conversation.
//   2. a per-conversation bar in the composer dock ("技能提示词"), which switches
//      skills on/off for the CURRENT conversation only — including skills that
//      the settings page leaves off. It never rewrites a note, so the global
//      default stays intact; "跟随设置" drops the override again.
//
// All reads and writes go through the host HTTP routes
// (`/api/dsh-skillmanager/*`) so the pointer config, the notes and the
// per-conversation overrides survive restarts.
//
// Format matches the dsh client `__ModuleLoader__` bundle contract:
//   window.__ModuleLoader__.load({ id, factory: (require) => ... })
// and the returned module is a plain Cordis plugin ({ inject, apply }).
window.__ModuleLoader__.load({
  id: "dsh-skillmanager",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    const PREFIX = "/api/dsh-skillmanager";
    const STATE_ROUTE = PREFIX + "/state";
    const CONFIG_ROUTE = PREFIX + "/config";
    const TOGGLE_ROUTE = PREFIX + "/toggle";
    const ADD_ROUTE = PREFIX + "/add";
    const IMPORT_ROUTE = PREFIX + "/import";
    const UPDATE_ROUTE = PREFIX + "/update";
    const REMOVE_ROUTE = PREFIX + "/remove";
    const OPEN_FOLDER_ROUTE = PREFIX + "/open-folder";
    // Per-conversation layer.
    const SESSION_ROUTE = PREFIX + "/session";
    const SESSION_OVERRIDE_ROUTE = PREFIX + "/session-override";
    const SESSION_RESET_ROUTE = PREFIX + "/session-reset";
    const SESSION_RESET_ALL_ROUTE = PREFIX + "/session-reset-all";

    const btnStyle = {
      padding: "4px 12px",
      fontSize: 13,
      border: "1px solid var(--border, #444)",
      borderRadius: 6,
      background: "transparent",
      color: "var(--text, inherit)",
      cursor: "pointer"
    };

    const inputStyle = {
      width: "100%",
      boxSizing: "border-box",
      padding: "6px 8px",
      fontSize: 13,
      background: "var(--bg, #111318)",
      color: "var(--text, inherit)",
      border: "1px solid var(--border, #444)",
      borderRadius: 6
    };

    // Small button used INSIDE the glass card: a translucent chip rather than a
    // solid-outline button, so it reads as part of the same material.
    const miniBtnStyle = {
      padding: "2px 8px",
      fontSize: 11,
      border: "1px solid rgba(255,255,255,0.18)",
      borderRadius: 6,
      background: "rgba(255,255,255,0.07)",
      backdropFilter: "blur(6px)",
      WebkitBackdropFilter: "blur(6px)",
      color: "inherit",
      cursor: "pointer",
      whiteSpace: "nowrap"
    };

    function Switch(props) {
      const checked = !!props.checked;
      return React.createElement(
        "label",
        { style: { display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" } },
        React.createElement("input", {
          type: "checkbox",
          checked,
          onChange: (e) => props.onChange && props.onChange(e.target.checked),
          style: { width: 16, height: 16, accentColor: "var(--accent, #4c9aff)" }
        }),
        React.createElement("span", { style: { fontSize: 12, minWidth: 40 } }, checked ? "注入" : "停用")
      );
    }

    // -----------------------------------------------------------------------
    // settings page — the GLOBAL default layer
    // -----------------------------------------------------------------------
    function SettingsPage() {
      const [state, setState] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState(null);
      const [name, setName] = React.useState("");
      const [description, setDescription] = React.useState("");
      const [content, setContent] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState(null);
      const [expanded, setExpanded] = React.useState({});
      const [editing, setEditing] = React.useState(null); // skill file currently being edited
      const [editDraft, setEditDraft] = React.useState("");
      const [editDesc, setEditDesc] = React.useState("");
      const [vaultDir, setVaultDir] = React.useState("");

      const reload = React.useCallback(() => {
        setLoading(true);
        fetch(STATE_ROUTE, { headers: { Accept: "application/json" } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
          .then((data) => {
            setState(data);
            setVaultDir(data && data.vaultDir ? data.vaultDir : "");
            setError(null);
          })
          .catch((e) => setError(e && e.message ? e.message : String(e)))
          .finally(() => setLoading(false));
      }, []);

      React.useEffect(() => { reload(); }, [reload]);

      const post = (route, body, onok) => {
        setBusy(true);
        setMsg(null);
        fetch(route, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {})
        })
          .then((r) => r.json())
          .then((data) => {
            if (data && data.error) setMsg("错误：" + data.error);
            else { if (onok) onok(data); reload(); }
          })
          .catch(() => setMsg("操作失败"))
          .finally(() => setBusy(false));
      };

      if (loading) {
        return React.createElement("div", { style: { padding: 16, opacity: 0.6 } }, "加载中…");
      }
      if (error) {
        return React.createElement(
          "div",
          { style: { padding: 16 } },
          React.createElement("div", { style: { color: "#e06060", marginBottom: 8 } }, "加载失败：" + error),
          React.createElement("button", { onClick: reload, style: btnStyle }, "重试")
        );
      }

      const skills = (state && state.skills) || [];
      const currentDir = (state && state.skillsDir) || "";
      const defaultDir = (state && state.defaultVaultDir) || "";
      const sessionOverrideCount = (state && state.sessionOverrideCount) || 0;

      return React.createElement(
        "div",
        { style: { padding: 16, fontFamily: "var(--font, sans-serif)", color: "var(--text, inherit)" } },
        React.createElement("div", { style: { fontSize: 12, opacity: 0.65, marginBottom: 12, lineHeight: 1.6 } },
          "管理自定义固定提示词：这里启用的技能内容会在每次模型请求时自动注入系统提示（全局默认，对所有对话生效）。技能以 Obsidian 笔记的形式存放在仓库的 skills/ 文件夹里，`enabled: true/false` 控制注入。"),

        // ---- vault pointer card ----
        React.createElement(
          "div",
          { style: { border: "1px solid var(--border, #333)", borderRadius: 8, padding: 10, marginBottom: 12 } },
          React.createElement("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, "技能仓库（Obsidian）地址"),
          React.createElement(
            "div",
            { style: { display: "flex", gap: 8, alignItems: "center" } },
            React.createElement("input", Object.assign({
              placeholder: defaultDir || "E:\\dsh\\DSH-Memory",
              value: vaultDir,
              onChange: (e) => setVaultDir(e.target.value),
              spellCheck: false
            }, { style: Object.assign({}, inputStyle, { flex: 1 }) })),
            React.createElement("button", {
              onClick: () => post(CONFIG_ROUTE, { vaultDir }, () => setMsg("仓库地址已更新")),
              disabled: busy || !vaultDir.trim(),
              style: Object.assign({}, btnStyle, { whiteSpace: "nowrap", color: "#4caf50" })
            }, "保存地址"),
            React.createElement("button", {
              onClick: () => post(OPEN_FOLDER_ROUTE, {}),
              disabled: busy,
              style: Object.assign({}, btnStyle, { whiteSpace: "nowrap" })
            }, "打开 skills 文件夹"),
            React.createElement("button", {
              onClick: reload,
              disabled: busy,
              style: Object.assign({}, btnStyle, { whiteSpace: "nowrap" })
            }, "刷新")
          ),
          currentDir
            ? React.createElement("div", { style: { fontSize: 11, opacity: 0.6, marginTop: 6 } },
                "当前生效：技能目录 = " + currentDir + "（<vaultDir>/skills）；放入该文件夹的 .md 笔记自动成为技能，可在 Obsidian 中直接编辑或改 frontmatter 的 enabled。）")
            : null
        ),

        // ---- per-conversation layer card ----
        React.createElement(
          "div",
          { style: { border: "1px solid var(--border, #333)", borderRadius: 8, padding: 10, marginBottom: 12 } },
          React.createElement("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, "对话级开关（本页 = 全局默认）"),
          React.createElement("div", { style: { fontSize: 12, opacity: 0.7, lineHeight: 1.6 } },
            "本页的「注入 / 停用」是全局默认，对所有对话生效。每个对话的左上角还有一个小药丸「技能提示词」：点开后可以在那一个对话里单独开关（包括本页默认未启用的技能），只影响该对话，不改本页设置、也不改笔记文件。"),
          React.createElement(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 8 } },
            React.createElement("span", { style: { fontSize: 12, opacity: 0.7, flex: 1 } },
              sessionOverrideCount
                ? sessionOverrideCount + " 个对话存在临时开关"
                : "当前没有对话使用临时开关"),
            React.createElement("button", {
              onClick: () => post(SESSION_RESET_ALL_ROUTE, {}, () => setMsg("已清除所有对话的临时开关")),
              disabled: busy || !sessionOverrideCount,
              style: Object.assign({}, btnStyle, { whiteSpace: "nowrap" })
            }, "清除所有对话的临时开关")
          )
        ),

        // ---- actions row: import ----
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 } },
          React.createElement(
            "label",
            { style: Object.assign({}, btnStyle, { display: "inline-flex", alignItems: "center", gap: 6 }) },
            React.createElement("input", {
              type: "file",
              accept: ".md,text/markdown",
              style: { display: "none" },
              onChange: (e) => {
                const f = e.target.files && e.target.files[0];
                e.target.value = "";
                if (!f) return;
                const reader = new FileReader();
                reader.onload = () =>
                  post(IMPORT_ROUTE, { file: f.name, content: String(reader.result || "") });
                reader.onerror = () => setMsg("读取文件失败");
                reader.readAsText(f, "utf-8");
              }
            }),
            "导入 .md 文件"
          ),
          React.createElement("span", { style: { fontSize: 11, opacity: 0.6 } },
            "按文件名导入，如「note.md」→ 仓库 skills/note.md；每个技能可单独开关注入")
        ),

        skills.length === 0
          ? React.createElement("div", { style: { opacity: 0.6, marginTop: 12, fontSize: 13 } },
              "暂无技能文件。可点「新增技能文件」创建，或把 .md 笔记直接放进 Obsidian 仓库的 skills/ 文件夹后点「刷新」。")
          : skills.map((s) => {
              const isExpanded = !!expanded[s.file];
              const isEditing = editing === s.file;
              return React.createElement(
                "div",
                { key: s.file, style: { marginTop: 8, border: "1px solid var(--border, #333)", borderRadius: 8, padding: 8 } },
                React.createElement(
                  "div",
                  { style: { display: "flex", alignItems: "center", gap: 8 } },
                  React.createElement(Switch, {
                    checked: !!s.enabled,
                    onChange: (v) => post(TOGGLE_ROUTE, { file: s.file, enabled: v })
                  }),
                  React.createElement(
                    "span",
                    { style: { flex: 1, minWidth: 0 } },
                    React.createElement(
                      "span",
                      { style: { wordBreak: "break-all", fontSize: 14, display: "block" } },
                      s.displayName + (s.enabled ? "" : " (停用)") + " · " + s.contentLength + " 字"
                    ),
                    s.description
                      ? React.createElement("span", { style: { display: "block", fontSize: 11, opacity: 0.6, wordBreak: "break-all" } },
                          s.description)
                      : null
                  ),
                  !isEditing && s.content.length > 0 &&
                    React.createElement(
                      "button",
                      {
                        onClick: () =>
                          setExpanded((prev) => Object.assign({}, prev, { [s.file]: !isExpanded })),
                        style: Object.assign({}, btnStyle, { whiteSpace: "nowrap" })
                      },
                      isExpanded ? "收起" : "预览"
                    ),
                  React.createElement("button", {
                    onClick: () => { setEditing(s.file); setEditDraft(s.content); setEditDesc(s.description || ""); },
                    disabled: busy,
                    style: btnStyle
                  }, "修改"),
                  React.createElement("button", {
                    onClick: () => post(REMOVE_ROUTE, { file: s.file }),
                    disabled: busy,
                    style: Object.assign({}, btnStyle, { color: "#e06060" })
                  }, "删除")
                ),
                isEditing
                  ? React.createElement(
                      "div",
                      { style: { marginTop: 8, display: "flex", flexDirection: "column", gap: 6 } },
                      React.createElement("input", Object.assign({
                        placeholder: "描述（可选）：何时使用，写清触发条件",
                        value: editDesc,
                        onChange: (e) => setEditDesc(e.target.value)
                      }, { style: inputStyle })),
                      React.createElement("textarea", Object.assign({
                        placeholder: "固定提示词内容：每次请求都会注入",
                        value: editDraft,
                        rows: 5,
                        onChange: (e) => setEditDraft(e.target.value)
                      }, { style: inputStyle })),
                      React.createElement(
                        "div",
                        { style: { display: "flex", gap: 8 } },
                        React.createElement("button", {
                          onClick: () =>
                            post(UPDATE_ROUTE, { file: s.file, content: editDraft, description: editDesc }, () => {
                              setEditing(null);
                            }),
                          disabled: busy,
                          style: Object.assign({}, btnStyle, { color: "#4caf50" })
                        }, "保存"),
                        React.createElement("button", {
                          onClick: () => setEditing(null),
                          style: btnStyle
                        }, "取消")
                      )
                    )
                  : isExpanded
                    ? React.createElement(
                        "div",
                        {
                          style: {
                            marginTop: 6,
                            padding: "6px 8px",
                            fontSize: 12,
                            lineHeight: 1.6,
                            background: "var(--bg-soft, rgba(255,255,255,0.03))",
                            border: "1px solid var(--border, #333)",
                            borderRadius: 6,
                            color: "var(--text-dim, inherit)",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            opacity: 0.9
                          }
                        },
                        s.content.length
                          ? s.content
                          : React.createElement("span", { style: { opacity: 0.5 } }, "(空内容)")
                      )
                    : null
              );
            }),

        // ---- add form ----
        React.createElement("div", { style: { borderTop: "1px solid var(--border, #333)", marginTop: 16, paddingTop: 12 } },
          React.createElement("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, "新增技能文件"),
          React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            React.createElement("input", Object.assign({
              placeholder: "名称（小写字母/数字/连字符，如 my-skill）→ 仓库 skills/my-skill.md",
              value: name,
              onChange: (e) => setName(e.target.value)
            }, { style: inputStyle })),
            React.createElement("input", Object.assign({
              placeholder: "描述（可选）：何时使用，写清触发条件",
              value: description,
              onChange: (e) => setDescription(e.target.value)
            }, { style: inputStyle })),
            React.createElement("textarea", Object.assign({
              placeholder: "固定提示词内容：每次请求都会注入",
              value: content,
              rows: 5,
              onChange: (e) => setContent(e.target.value)
            }, { style: inputStyle })),
            React.createElement("div", null,
              React.createElement("button", {
                onClick: () =>
                  post(ADD_ROUTE, { name, content, description }, () => { setName(""); setDescription(""); setContent(""); }),
                disabled: busy || !name.trim(),
                style: btnStyle
              }, "添加"))
          )
        ),
        msg ? React.createElement("div", { style: { color: "#e0a050", marginTop: 10, fontSize: 13 } }, msg) : null
      );
    }

    // -----------------------------------------------------------------------
    // conversation corner — the PER-CONVERSATION layer
    // -----------------------------------------------------------------------
    // A small pill parked at the TOP-LEFT of the conversation panel, under the
    // title/tabs strip and over the empty gutter left of the message column.
    // Opening it grows a fixed-width card DOWNWARD whose body scrolls once it
    // outgrows ~52vh, so it never pushes the transcript around.
    //
    // Placement matters: the pill is mounted through the Session header's action
    // slot (whose ancestors up to the conversation root are unpositioned and
    // unclipped), so `position: absolute` resolves against the conversation panel
    // itself. While a conversation is still blank the framework hides that
    // header, so the same component is also contributed to the composer dock in
    // inline mode — that entry renders ONLY while the conversation is blank, so
    // the two never show at once and a brand-new conversation can still set its
    // skills before the first message.
    function describeRow(s) {
      const def = s.defaultEnabled ? "默认注入" : "默认停用";
      if (s.override === null || s.override === undefined) return def + " · 跟随设置";
      const own = s.override ? "本会话注入" : "本会话停用";
      return def + " · " + own + (s.inheritedFrom ? "（继承自上级对话）" : "");
    }

    // Theme tokens with neutral fallbacks, so the floating card reads correctly
    // on both the dark and the light surface.
    const LABEL_PRIMARY = "var(--dsw-alias-label-primary, var(--text, inherit))";
    const LABEL_SECONDARY = "var(--dsw-alias-label-secondary, var(--text, inherit))";
    const LABEL_TERTIARY = "var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))";

    // ---------------------------------------------------------------------
    // Popover motion
    // ---------------------------------------------------------------------
    // The same open transition the wallpaper plugin's popovers use: fade in from
    // just above the anchor while scaling up a hair, settled by ease-out-expo.
    // The keyframes live in one injected stylesheet (the panel itself is built
    // from inline styles, which cannot declare @keyframes).
    const PANEL_ANIMATION = "dsm-panel-in 190ms cubic-bezier(.16,1,.3,1) both";
    const MOTION_TAG = "dsh-skillmanager/motion";
    const MOTION_CSS =
      "@keyframes dsm-panel-in{from{opacity:0;transform:translateY(-7px) scale(.97)}" +
      "to{opacity:1;transform:translateY(0) scale(1)}}" +
      "@media (prefers-reduced-motion: reduce){.dsm-panel{animation:none}}";

    function ensureMotionStyles() {
      try {
        if (typeof document === "undefined") return;
        if (document.querySelector('style[data-plugin-css="' + MOTION_TAG + '"]')) return;
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-skillmanager";
        tag.dataset.pluginCss = MOTION_TAG;
        tag.textContent = MOTION_CSS;
        document.head.appendChild(tag);
      } catch (e) {
        /* no document / blocked head — the animation is purely cosmetic */
      }
    }

    // ---------------------------------------------------------------------
    // Liquid-glass material
    // ---------------------------------------------------------------------
    // Composed from the four ingredients the WWDC25 material is described by —
    // frosted transmission, an edge that catches light, a floating shadow, and a
    // specular sweep — WITHOUT an SVG displacement map on the backdrop: Chrome
    // accepts `backdrop-filter: url(#…)` but a hand-made displacement map
    // smears the whole surface instead of refracting just the rim, which is
    // exactly the "浑浊/拉丝" failure the reference article calls out.
    const SUPPORTS_COLOR_MIX = (() => {
      try {
        return (
          typeof CSS !== "undefined" &&
          typeof CSS.supports === "function" &&
          CSS.supports("background-color", "color-mix(in srgb, red 30%, transparent)")
        );
      } catch (e) {
        return false;
      }
    })();
    // Theme-aware translucent tint: the surface colour at a light strength, so
    // the glass stays CLEAR — the backdrop reads through it — while the card
    // still separates from the transcript. These two values are the knobs:
    // raise the percentage / blur radius for a frostier surface, lower them for
    // more clarity.
    const GLASS_TINT = SUPPORTS_COLOR_MIX
      ? "color-mix(in srgb, var(--dsw-alias-bg-base, #23232a) 18%, transparent)"
      : "rgba(255,255,255,0.08)";
    const GLASS_BLUR = "blur(15px) saturate(160%) brightness(1.02)";
    // No rim, no inner edge light: the surface separates from the transcript by
    // the floating shadow alone, so the glass reads as clear sheet instead of a
    // rimmed card. Only the drop shadow stays.
    const GLASS_SHADOW = [
      "0 16px 40px rgba(0,0,0,0.26)",
      "0 2px 8px rgba(0,0,0,0.14)"
    ].join(", ");
    // Fine grain gives the surface a material feel instead of flat translucency.
    const GLASS_GRAIN =
      "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'>" +
      "<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='2' stitchTiles='stitch'/>" +
      "<feColorMatrix type='saturate' values='0'/></filter>" +
      "<rect width='120' height='120' filter='url(%23g)'/></svg>\")";

    function glassSurface(options) {
      const radius = options && options.radius !== undefined ? options.radius : 16;
      const blur = (options && options.blur) || GLASS_BLUR;
      return {
        backgroundColor: GLASS_TINT,
        backdropFilter: blur,
        WebkitBackdropFilter: blur,
        border: "none",
        borderRadius: radius,
        boxShadow: GLASS_SHADOW,
        overflow: "hidden"
      };
    }

    // The two non-interactive layers that sit between the glass and its content:
    // a specular sweep from the top-left, and the grain.
    function GlassLayers() {
      return React.createElement(
        React.Fragment,
        null,
        React.createElement("div", {
          "aria-hidden": true,
          style: {
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            borderRadius: "inherit",
            background:
              "radial-gradient(130% 90% at 16% -14%, rgba(255,255,255,0.24), rgba(255,255,255,0.04) 38%, rgba(255,255,255,0) 64%), " +
              "linear-gradient(125deg, rgba(255,255,255,0.06), rgba(255,255,255,0) 46%, rgba(255,255,255,0.04))"
          }
        }),
        React.createElement("div", {
          "aria-hidden": true,
          style: {
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            borderRadius: "inherit",
            opacity: 0.16,
            mixBlendMode: "overlay",
            backgroundImage: GLASS_GRAIN,
            backgroundSize: "120px 120px"
          }
        })
      );
    }

    function SessionSkillsBar(props) {
      const corner = props.placement !== "inline";
      const sessionId =
        (typeof props.sessionId === "string" && props.sessionId) ||
        (props.session && props.session.sessionId) ||
        "";
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const rootRef = React.useRef(null);

      const load = React.useCallback(() => {
        if (!sessionId) return;
        fetch(SESSION_ROUTE, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId })
        })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
          .then((d) => {
            if (d && d.error) {
              setError(String(d.error));
              return;
            }
            setData(d);
            setError(null);
          })
          .catch((e) => setError(e && e.message ? e.message : String(e)));
      }, [sessionId]);

      React.useEffect(() => { load(); }, [load]);
      // Opening the panel re-reads the host so settings-page edits show up.
      React.useEffect(() => { if (open) load(); }, [open, load]);
      // Close on an outside click or Escape, like any other popover.
      React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          const node = rootRef.current;
          if (node && typeof node.contains === "function" && !node.contains(event.target)) setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onDown, true);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);

      const post = (route, body) => {
        if (!sessionId) return;
        setBusy(true);
        fetch(route, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Object.assign({ sessionId }, body || {}))
        })
          .then((r) => r.json())
          .then((d) => {
            if (d && d.error) setError(String(d.error));
            else if (d && Array.isArray(d.skills)) { setData(d); setError(null); }
          })
          .catch((e) => setError(e && e.message ? e.message : String(e)))
          .finally(() => setBusy(false));
      };

      if (!sessionId) return null;

      // Wrapper: floating (corner) or in-flow (blank conversation hero).
      const wrapStyle = corner
        ? {
            position: "absolute",
            left: 12,
            top: 86,
            zIndex: 30,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            lineHeight: "normal"
          }
        : {
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            width: "100%",
            lineHeight: "normal"
          };

      // The pill is glass too, only thinner: same tint, a shorter blur, the same
      // shadow-only separation. The open state marks itself with a thin accent
      // hairline instead of a white rim.
      const pillStyle = Object.assign({}, glassSurface({ radius: 999, blur: "blur(11px) saturate(155%) brightness(1.02)" }), {
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 11px",
        fontSize: 12,
        lineHeight: "18px",
        fontFamily: "inherit",
        color: LABEL_PRIMARY,
        cursor: "pointer",
        whiteSpace: "nowrap",
        boxShadow: GLASS_SHADOW
      });

      // A failed host call still leaves a way back in (retry), so the entry never
      // silently disappears while the routes are unavailable.
      if (!data) {
        if (!error) return null;
        return React.createElement(
          "div",
          { ref: rootRef, style: wrapStyle },
          React.createElement(
            "button",
            { type: "button", onClick: load, title: error, style: Object.assign({}, pillStyle, { color: "#e0a050" }) },
            React.createElement("span", null, "技能提示词"),
            React.createElement("span", { style: { opacity: 0.8, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" } },
              "不可用 · 点此重试")
          )
        );
      }

      const skills = (data && data.skills) || [];
      // Nothing to switch in this vault: stay out of the way.
      if (skills.length === 0) return null;

      const overrides = (data && data.overrideCount) || 0;
      const effective = (data && data.effectiveCount) || 0;

      const rows = skills.map((s, index) =>
        React.createElement(
          "div",
          {
            key: s.file,
            style: {
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 0",
              borderTop: index === 0 ? "none" : "1px solid rgba(255,255,255,0.14)"
            }
          },
          React.createElement(
            "span",
            { style: { flex: 1, minWidth: 0 } },
            React.createElement(
              "span",
              { style: { display: "block", fontSize: 12, color: LABEL_PRIMARY, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
              s.displayName
            ),
            React.createElement(
              "span",
              { style: { display: "block", fontSize: 10.5, color: LABEL_TERTIARY, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
              describeRow(s) + " · " + s.contentLength + " 字"
            )
          ),
          s.override === null || s.override === undefined
            ? null
            : React.createElement("button", {
                type: "button",
                onClick: () => post(SESSION_OVERRIDE_ROUTE, { file: s.file, enabled: null }),
                disabled: busy,
                title: "清除本会话开关，回到设置页的默认值",
                style: Object.assign({}, miniBtnStyle, { padding: "1px 6px", fontSize: 10.5 })
              }, "跟随设置"),
          React.createElement(
            "label",
            { style: { display: "inline-flex", alignItems: "center", gap: 4, flex: "none", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 } },
            React.createElement("input", {
              type: "checkbox",
              checked: !!s.effective,
              disabled: busy,
              onChange: (e) => post(SESSION_OVERRIDE_ROUTE, { file: s.file, enabled: e.target.checked }),
              style: { width: 15, height: 15, margin: 0, accentColor: "var(--accent, #4c9aff)" }
            }),
            React.createElement("span", { style: { fontSize: 10.5, minWidth: 22, color: s.effective ? LABEL_SECONDARY : LABEL_TERTIARY } },
              s.effective ? "注入" : "停用")
          )
        )
      );

      const panel = open
        ? React.createElement(
            "div",
            {
              className: "dsm-panel",
              style: Object.assign({}, glassSurface({ radius: 16 }), {
                position: "relative",
                marginTop: 8,
                width: 320,
                maxWidth: "calc(100vw - 40px)",
                maxHeight: "min(52vh, 460px)",
                display: "flex",
                flexDirection: "column",
                color: LABEL_PRIMARY,
                // 展开动画：从药丸正下方(左上角锚点)淡入 + 轻微放大，和壁纸插件
                // 那两个弹层同一套手感；关键帧由 ensureMotionStyles() 注入一次。
                animation: PANEL_ANIMATION,
                transformOrigin: "top left",
                willChange: "transform, opacity"
              })
            },
            React.createElement(GlassLayers),
            // Everything readable sits above the sheen/grain layers.
            React.createElement(
              "div",
              { style: { position: "relative", zIndex: 1, display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } },
              // fixed head
              React.createElement(
                "div",
                {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 11px",
                    borderBottom: "1px solid rgba(255,255,255,0.16)",
                    fontSize: 12,
                    fontWeight: 600,
                    color: LABEL_PRIMARY,
                    flex: "none"
                  }
                },
                React.createElement("span", null, "技能提示词"),
                React.createElement("span", { style: { flex: 1, minWidth: 0, fontWeight: 400, fontSize: 11, color: LABEL_TERTIARY, textAlign: "right" } },
                  (overrides ? overrides + " 项本会话开关 · " : "跟随设置 · ") + "生效 " + effective + "/" + skills.length)
              ),
              // scrollable body
              React.createElement(
                "div",
                { style: { flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "2px 11px 4px" } },
                error
                  ? React.createElement("div", { style: { fontSize: 11, color: "#e0a050", padding: "4px 0", wordBreak: "break-all" } }, "错误：" + error)
                  : null,
                rows
              ),
              // fixed foot
              React.createElement(
                "div",
                {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 11px",
                    borderTop: "1px solid rgba(255,255,255,0.16)",
                    flex: "none"
                  }
                },
                React.createElement("button", {
                  type: "button",
                  onClick: () => post(SESSION_RESET_ROUTE, {}),
                  disabled: busy || !overrides,
                  title: "清除本对话的全部开关，全部回到设置页的默认值",
                  style: miniBtnStyle
                }, "全部恢复默认"),
                React.createElement("span", { style: { flex: 1, fontSize: 10, color: LABEL_TERTIARY, lineHeight: 1.4 } },
                  "只影响当前对话")
              )
            )
          )
        : null;

      return React.createElement(
        "div",
        { ref: rootRef, style: wrapStyle },
        React.createElement(
          "button",
          {
            type: "button",
            onClick: () => setOpen((v) => !v),
            "aria-expanded": open,
            title: "技能提示词开关（只影响当前对话）",
            style: Object.assign({}, pillStyle, open
              ? {
                  borderColor: SUPPORTS_COLOR_MIX
                    ? "color-mix(in srgb, var(--dsw-alias-state-business-primary, #4c9aff) 60%, transparent)"
                    : "rgba(76,154,255,0.6)"
                }
              : {})
          },
          React.createElement("span", { style: { opacity: 0.6, fontSize: 10 } }, open ? "▾" : "▸"),
          React.createElement("span", { style: { fontWeight: 600 } }, "技能提示词"),
          React.createElement("span", { style: { color: overrides ? "var(--dsw-alias-state-business-primary, inherit)" : LABEL_TERTIARY } },
            effective + "/" + skills.length + (overrides ? " · 本会话" : ""))
        ),
        panel
      );
    }

    // The blank-conversation entry: the framework hides the Session header until
    // the first turn exists, so this dock contribution only fills that gap.
    function BlankConversationSkillsBar(props) {
      const session = props.session;
      if (!session || session.blank !== true) return null;
      return React.createElement(
        SessionSkillsBar,
        Object.assign({}, props, { placement: "inline" })
      );
    }

    function apply(ctx) {
      // Keyframes for the panel's open transition (inline styles cannot declare them).
      ensureMotionStyles();
      const slots = ctx.get("slots");
      if (!slots) return;
      slots.inject("settings.section", () =>
        slots.register(
          { name: "settings.section", id: "dsh-skillmanager", order: 55, label: "固定提示词" },
          () => React.createElement(SettingsPage)
        )
      );
      // Primary entry: the corner pill, mounted through the Session header's
      // action slot. Its ancestors up to the conversation root are unpositioned
      // and unclipped, so the card can open downward over the transcript.
      slots.inject("conversation.session.header.actions", () =>
        slots.register(
          {
            name: "conversation.session.header.actions",
            id: "dsh-skillmanager-session-skills",
            order: 20,
            inject: (sessionId) => ({ sessionId, placement: "corner" })
          },
          SessionSkillsBar
        )
      );
      // Blank conversation: the header is hidden until the first turn, so the
      // same pill is offered above the hero composer instead.
      slots.inject("conversation.input.dock", () =>
        slots.register(
          {
            name: "conversation.input.dock",
            id: "dsh-skillmanager-empty-session-skills",
            order: 20,
            inject: (sessionId) => ({ sessionId, placement: "inline" })
          },
          BlankConversationSkillsBar
        )
      );
    }

    module.exports = { inject: ["slots"], apply };
    return module.exports;
  }
});

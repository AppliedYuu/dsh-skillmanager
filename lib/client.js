// dsh-custom-skills — client (browser) half.
//
// Registers an additive "固定提示词" settings page that lists every custom skill
// with an enable/disable toggle, a delete button, and an add form. All reads
// and writes go through the host HTTP routes (`/api/dsh-custom-skills/*`) so
// the registry survives restarts.
//
// Format matches the dsh client `__ModuleLoader__` bundle contract:
//   window.__ModuleLoader__.load({ id, factory: (require) => ... })
// and the returned module is a plain Cordis plugin ({ inject, apply }).
window.__ModuleLoader__.load({
  id: "dsh-custom-skills",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    const STATE_ROUTE = "/api/dsh-custom-skills/state";
    const POWER_ROUTE = "/api/dsh-custom-skills/power";
    const TOGGLE_ROUTE = "/api/dsh-custom-skills/toggle";
    const ADD_ROUTE = "/api/dsh-custom-skills/add";
    const REMOVE_ROUTE = "/api/dsh-custom-skills/remove";

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
        React.createElement("span", { style: { fontSize: 12, minWidth: 40 } }, checked ? "启用" : "停用")
      );
    }

    function SettingsPage() {
      const [state, setState] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState(null);
      const [name, setName] = React.useState("");
      const [content, setContent] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState(null);

      const reload = React.useCallback(() => {
        setLoading(true);
        fetch(STATE_ROUTE, { headers: { Accept: "application/json" } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
          .then((data) => { setState(data); setError(null); })
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
            else { if (onok) onok(); reload(); }
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

      return React.createElement(
        "div",
        { style: { padding: 16, fontFamily: "var(--font, sans-serif)", color: "var(--text, inherit)" } },
        React.createElement("div", { style: { fontSize: 12, opacity: 0.65, marginBottom: 12, lineHeight: 1.6 } },
          "管理自定义固定提示词：启用的技能内容会在每次模型请求时自动注入系统提示。"),
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 } },
          React.createElement(Switch, {
            checked: !!(state && state.enabled),
            onChange: (v) => post(POWER_ROUTE, { enabled: v })
          }),
          React.createElement("span", { style: { fontSize: 14 } },
            "全局注入 " + (state && state.enabled ? "开 (ON)" : "关 (OFF)"))
        ),
        skills.length === 0
          ? React.createElement("div", { style: { opacity: 0.6, marginTop: 12, fontSize: 13 } }, "暂无技能文件")
          : skills.map((s) =>
              React.createElement(
                "div",
                { key: s.name, style: { display: "flex", alignItems: "center", gap: 8, marginTop: 8 } },
                React.createElement(Switch, {
                  checked: !!s.enabled,
                  onChange: (v) => post(TOGGLE_ROUTE, { name: s.name, enabled: v })
                }),
                React.createElement("span", { style: { flex: 1, wordBreak: "break-all", fontSize: 14 } },
                  s.name + (s.enabled ? "" : " (停用)") + " · " + s.contentLength + " 字"),
                React.createElement("button", {
                  onClick: () => post(REMOVE_ROUTE, { name: s.name }),
                  disabled: busy,
                  style: Object.assign({}, btnStyle, { color: "#e06060" })
                }, "删除")
              )
            ),
        React.createElement("div", { style: { borderTop: "1px solid var(--border, #333)", marginTop: 16, paddingTop: 12 } },
          React.createElement("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, "新增技能文件"),
          React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            React.createElement("input", Object.assign({
              placeholder: "名称（小写字母/数字/连字符）",
              value: name,
              onChange: (e) => setName(e.target.value)
            }, { style: inputStyle })),
            React.createElement("textarea", Object.assign({
              placeholder: "固定提示词内容：每次请求都会注入",
              value: content,
              rows: 5,
              onChange: (e) => setContent(e.target.value)
            }, { style: inputStyle })),
            React.createElement("div", null,
              React.createElement("button", {
                onClick: () => post(ADD_ROUTE, { name, content }, () => { setName(""); setContent(""); }),
                disabled: busy || !name.trim(),
                style: btnStyle
              }, "添加"))
          )
        ),
        msg ? React.createElement("div", { style: { color: "#e0a050", marginTop: 10, fontSize: 13 } }, msg) : null
      );
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (!slots) return;
      slots.inject("settings.section", () =>
        slots.register(
          { name: "settings.section", id: "dsh-custom-skills", order: 55, label: "固定提示词" },
          () => React.createElement(SettingsPage)
        )
      );
    }

    module.exports = { inject: ["slots"], apply };
    return module.exports;
  }
});

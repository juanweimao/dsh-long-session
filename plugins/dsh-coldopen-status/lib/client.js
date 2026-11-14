/**
 * dsh-coldopen-status —— 客户端半边：设置 → 「冷开状态」一节。
 *
 * 宿主半边（lib/index.js）把状态挂在 /api/cold-open（POST），这里只读渲染。
 * 与 dsh-session-trash 的客户端写法一致：ModuleLoader 包装 + React + 原生元素，
 * 不依赖额外的 UI 组件包，拿不到也不会把条目搞挂。
 */
window.__ModuleLoader__.load({
  id: "dsh-coldopen-status",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;
    var API = "/api/cold-open";

    var css =
      ".cos-section{max-width:860px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}" +
      ".cos-head{display:flex;align-items:center;justify-content:space-between;gap:12px}" +
      ".cos-title{margin:0;font-size:18px;font-weight:600}" +
      ".cos-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0;border-radius:8px;padding:4px 12px;font-size:12px;line-height:1.5}" +
      ".cos-btn:hover:not(:disabled){color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}" +
      ".cos-btn:disabled{opacity:.5;cursor:default}" +
      ".cos-intro,.cos-note,.cos-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0;line-height:1.6}" +
      ".cos-err{color:var(--dsw-alias-label-error);font-size:12px;margin:0}" +
      ".cos-rows{display:flex;flex-direction:column;gap:8px}" +
      ".cos-row{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:14px;padding:10px 14px}" +
      ".cos-row-main{display:flex;flex-direction:column;gap:3px;min-width:0}" +
      ".cos-id{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".cos-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}";

    function installCss() {
      if (document.getElementById("coldopen-status-css")) return;
      var style = document.createElement("style");
      style.id = "coldopen-status-css";
      style.textContent = css;
      document.head.appendChild(style);
    }

    function post(body) {
      return fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then(function (response) {
        return response.text().then(function (text) {
          var parsed = null;
          try { parsed = JSON.parse(text); } catch (error) { parsed = null; }
          if (!response.ok) throw new Error("HTTP " + response.status + " @ " + API + (text ? " · " + text.slice(0, 160) : ""));
          if (parsed === null) throw new Error("响应不是 JSON @ " + API + " · " + text.slice(0, 160));
          return parsed;
        });
      });
    }

    var fmt = function (value) { return value === null || value === undefined ? "-" : Number(value).toLocaleString("en-US"); };
    var kb = function (bytes) { return ((bytes || 0) / 1024).toFixed(0) + " KB"; };
    var mb = function (bytes) { return ((bytes || 0) / 1048576).toFixed(1); };

    function ago(ms) {
      if (!ms) return "未知";
      var seconds = Math.max(0, (Date.now() - ms) / 1000);
      if (seconds < 90) return Math.round(seconds) + " 秒前";
      if (seconds < 5400) return Math.round(seconds / 60) + " 分钟前";
      if (seconds < 172800) return Math.round(seconds / 3600) + " 小时前";
      return Math.round(seconds / 86400) + " 天前";
    }

    function ColdOpenSection() {
      var stateHook = React.useState(null);
      var data = stateHook[0];
      var setData = stateHook[1];
      var errorHook = React.useState(null);
      var error = errorHook[0];
      var setError = errorHook[1];
      var busyHook = React.useState(true);
      var busy = busyHook[0];
      var setBusy = busyHook[1];

      function load() {
        setBusy(true);
        post({})
          .then(function (payload) {
            if (!payload || !payload.ok) throw new Error((payload && payload.error) || "读取失败");
            setData(payload.value);
            setError(null);
          })
          .catch(function (failure) {
            setError(String((failure && failure.message) || failure));
          })
          .then(function () { setBusy(false); });
      }

      React.useEffect(function () { load(); }, []);

      var rows = data && data.sessions ? data.sessions : [];
      return h(
        "section",
        { className: "cos-section" },
        h(
          "div",
          { className: "cos-head" },
          h("h2", { className: "cos-title" }, "冷开状态"),
          h("button", { className: "cos-btn", onClick: load, disabled: busy }, busy ? "读取中…" : "刷新"),
        ),
        h(
          "p",
          { className: "cos-intro" },
          data === null
            ? "正在读取…"
            : (data.enabled ? "开关 ON · " : "开关 OFF（" + data.marker + " 不存在）· ") + "按会话日志更新时间排序",
        ),
        error === null ? null : h("p", { className: "cos-err" }, error),
        data !== null && rows.length === 0
          ? h("p", { className: "cos-empty" }, "还没有检查点。打开长会话跑完一轮 turn/end 后会写入。")
          : null,
        h(
          "div",
          { className: "cos-rows" },
          rows.map(function (session) {
            return h(
              "div",
              { className: "cos-row", key: session.id },
              h(
                "div",
                { className: "cos-row-main" },
                h("div", { className: "cos-id", title: session.id }, session.id),
                h(
                  "div",
                  { className: "cos-meta" },
                  "cut " + fmt(session.cut) + " · " + (session.reason || "?") +
                    " · 检查点 " + kb(session.checkpointBytes) + " · " + ago(session.checkpointMtime) +
                    (session.derived.length ? " · 派生 " + session.derived.join(", ") : " · 无派生"),
                ),
                h(
                  "div",
                  { className: "cos-meta" },
                  "索引 " + (session.indexBytes ? mb(session.indexBytes) + " MB · " + ago(session.indexMtime) : "无") +
                    " · 日志 " + (session.logBytes ? mb(session.logBytes) + " MB · " + ago(session.logMtime) : "未找到"),
                ),
              ),
            );
          }),
        ),
        h(
          "p",
          { className: "cos-note" },
          "只读面板；数据来自 " + (data === null ? "~/.dsh/surface-checkpoints" : data.dir) +
            "。开关文件：~/.dsh/cold-open.on。会话内也可以输入 /coldopen 查看当前会话的详细状态。",
        ),
      );
    }

    function apply(ctx) {
      installCss();
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          {
            name: "settings.section",
            id: "cold-open-status",
            order: 30,
            label: function () { return "冷开状态"; },
            inject: function () { return {}; },
          },
          ColdOpenSection,
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});

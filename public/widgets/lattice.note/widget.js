/**
 * 便签组件
 *
 * 这个组件存在的意义不是"便签"这个功能，而是验证平台的一个硬问题：
 * 组件里能不能正常输入。桌面端窗口是 WS_EX_NOACTIVATE（永不激活）的，
 * 输入框要打字就必须有焦点 —— 这两件事在 Win32 层是打架的。
 * 在浏览器预览里它只是普通 textarea，到了独立窗口才见真章。
 */
(function () {
  "use strict";

  // ---------- 极简桥客户端 ----------
  var seq = 0;
  var pending = new Map();

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage({ __lattice: 1, type: "request", id: id, method: method, params: params }, "*");
      setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error("桥调用超时：" + method));
      }, 3000);
    });
  }

  var THEME_MAP = {
    "--lattice-surface": "--surface",
    "--lattice-text": "--fg",
    "--lattice-text-muted": "--muted",
    "--lattice-accent": "--accent",
    "--lattice-border": "--border",
    "--lattice-radius": "--radius",
    "--lattice-font": "--font",
  };

  function applyTheme(tokens) {
    if (!tokens) return;
    Object.keys(THEME_MAP).forEach(function (source) {
      var value = tokens[source];
      if (value) document.documentElement.style.setProperty(THEME_MAP[source], value);
    });
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__lattice !== 1) return;
    if (data.type === "theme") {
      applyTheme(data.payload);
      return;
    }
    if (data.type !== "response") return;
    var entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) {
      entry.resolve(data.result);
    } else {
      var error = new Error(data.error || "桥调用失败");
      error.code = data.code;
      entry.reject(error);
    }
  });

  // ---------- 业务 ----------
  var textEl = document.getElementById("text");
  var statusEl = document.getElementById("status");
  var countEl = document.getElementById("count");

  var timer = null;
  var dirty = false;

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind ? "is-" + kind : "";
  }

  function updateCount() {
    countEl.textContent = Array.from(textEl.value).length + " 字";
  }

  function save() {
    if (!dirty) return;
    dirty = false;
    setStatus("保存中…", "");
    call("storage.set", { key: "text", value: textEl.value })
      .then(function () {
        setStatus("已保存", "saved");
      })
      .catch(function (error) {
        dirty = true;
        setStatus(
          error.code === "permission_denied" ? "未授予存储权限" : "保存失败",
          "error",
        );
      });
  }

  textEl.addEventListener("input", function () {
    dirty = true;
    updateCount();
    setStatus("未保存", "");
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  });

  // 失焦立刻落盘，避免用户切走时最后 400ms 的输入丢掉
  textEl.addEventListener("blur", function () {
    clearTimeout(timer);
    save();
  });

  call("storage.get", { key: "text" })
    .then(function (value) {
      if (typeof value === "string") textEl.value = value;
      updateCount();
      setStatus("已载入", "saved");
    })
    .catch(function (error) {
      updateCount();
      setStatus(
        error.code === "permission_denied" ? "未授予存储权限" : "读取失败",
        "error",
      );
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();

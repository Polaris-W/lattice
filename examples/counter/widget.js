/**
 * 计数器 —— 第三方组件的示例
 *
 * 这个文件里没有一行平台代码：它只会 postMessage。
 * 平台换实现（iframe → 独立进程）时，这里不用改。
 */
(function () {
  "use strict";

  var seq = 0;
  var pending = new Map();

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage(
        { __lattice: 1, type: "request", id: id, method: method, params: params },
        "*"
      );
      setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error("Bridge call timed out: " + method));
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
    if (data.type === "response") {
      var entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.error) entry.reject(new Error(data.error.message || "Call failed"));
      else entry.resolve(data.result);
    }
  });

  var valueEl = document.getElementById("value");
  var count = 0;

  function render() {
    valueEl.textContent = String(count);
  }

  document.getElementById("bump").addEventListener("click", function () {
    count += 1;
    render();
    call("storage.set", { key: "count", value: count }).catch(function () {});
  });

  // 告诉宿主"我准备好了"，宿主收到后会回推一次主题
  parent.postMessage({ __lattice: 1, type: "ready" }, "*");

  call("storage.get", { key: "count" })
    .then(function (value) {
      if (typeof value === "number") {
        count = value;
        render();
      }
    })
    .catch(function () {});
})();

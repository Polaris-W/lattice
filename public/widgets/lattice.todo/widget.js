/**
 * 待办清单组件
 *
 * 数据全部走 storage 桥，组件自己不碰 localStorage ——
 * 沙箱 iframe 是不透明源，localStorage 本来就不可用，
 * 这样也顺带保证了"同一组件的多个实例共享同一份数据"。
 */
(function () {
  "use strict";

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
  var STORAGE_KEY = "items";
  var items = [];

  var formEl = document.getElementById("form");
  var inputEl = document.getElementById("input");
  var listEl = document.getElementById("list");
  var emptyEl = document.getElementById("empty");

  function persist() {
    call("storage.set", { key: STORAGE_KEY, value: items }).catch(function (error) {
      inputEl.placeholder =
        error.code === "permission_denied" ? "需要「组件私有存储」权限才能保存" : "保存失败";
    });
  }

  function render() {
    listEl.textContent = "";
    items.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "todo-item" + (item.done ? " is-done" : "");

      var check = document.createElement("input");
      check.type = "checkbox";
      check.className = "todo-check";
      check.checked = item.done;
      check.addEventListener("change", function () {
        item.done = check.checked;
        render();
        persist();
      });

      var text = document.createElement("span");
      text.className = "todo-text";
      text.textContent = item.text;
      text.title = item.text;
      text.addEventListener("click", function () {
        item.done = !item.done;
        render();
        persist();
      });

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "todo-remove";
      remove.textContent = "×";
      remove.title = "删除";
      remove.addEventListener("click", function () {
        items = items.filter(function (candidate) {
          return candidate.id !== item.id;
        });
        render();
        persist();
      });

      li.appendChild(check);
      li.appendChild(text);
      li.appendChild(remove);
      listEl.appendChild(li);
    });
    emptyEl.classList.toggle("is-visible", items.length === 0);
  }

  formEl.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = inputEl.value.trim();
    if (!text) return;
    items.unshift({ id: String(Date.now()) + Math.random().toString(16).slice(2, 6), text: text, done: false });
    inputEl.value = "";
    render();
    persist();
  });

  call("storage.get", { key: STORAGE_KEY })
    .then(function (value) {
      if (Array.isArray(value)) {
        items = value.filter(function (item) {
          return item && typeof item.text === "string";
        });
      }
    })
    .catch(function () {})
    .then(function () {
      render();
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();

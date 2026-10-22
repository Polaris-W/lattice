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

  // ---------- 业务 ----------
  var STORAGE_KEY = "items";
  var items = [];

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__lattice !== 1) return;
    if (data.type === "theme") {
      applyTheme(data.payload);
      return;
    }
    if (data.type === "store-changed") {
      var key = data.payload && data.payload.key;
      // 空 key = 整份文件被替换过，什么都要重读
      if (!key || key === STORAGE_KEY) reload();
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

  var formEl = document.getElementById("form");
  var inputEl = document.getElementById("input");
  var listEl = document.getElementById("list");
  var emptyEl = document.getElementById("empty");

  /*
   * 同一个组件可能在画布上有一个实例、桌面上又有一个，各自持一份内存列表。
   * 平台在每次落盘后广播 store-changed，收到就重读 —— 否则后写的那份会把
   * 对方刚加的事项整块覆盖掉，用户看到的是"加了几条，回头只剩一条"。
   *
   * 两个刹车：
   *   writing     自己的写入还在飞，这时候读到的可能是旧文件，等它落地再读
   *   pendingReload 在飞期间收到的通知，落地后补一次
   */
  var writing = 0;
  var pendingReload = false;

  function persist() {
    writing += 1;
    call("storage.set", { key: STORAGE_KEY, value: items })
      .catch(function (error) {
        inputEl.placeholder =
          error.code === "permission_denied" ? "需要「组件私有存储」权限才能保存" : "保存失败";
      })
      .then(function () {
        writing -= 1;
        if (writing === 0 && pendingReload) {
          pendingReload = false;
          reload();
        }
      });
  }

  /** 从磁盘重读。内容没变就不重画，免得自己的回声把列表抖一下 */
  function reload() {
    if (writing > 0) {
      pendingReload = true;
      return;
    }
    call("storage.get", { key: STORAGE_KEY })
      .then(function (value) {
        if (!Array.isArray(value)) return;
        var next = value.filter(function (item) {
          return item && typeof item.text === "string";
        });
        if (JSON.stringify(next) === JSON.stringify(items)) return;
        items = next;
        render();
      })
      .catch(function () {});
  }

  /**
   * 用户是否已经动过这份列表。
   *
   * 载入是异步的：用户可能在磁盘内容回来之前就加了一条。那种情况下
   * 磁盘上的旧列表优先级最低，不能把它盖到用户刚改完的列表上 ——
   * 否则新加的那条会当场消失。
   */
  var touched = false;

  /** 改完状态统一走这里：重画 + 落盘 */
  function commit() {
    touched = true;
    render();
    persist();
  }

  function render() {
    listEl.textContent = "";

    items.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "todo-item" + (item.done ? " is-done" : "");

      // 自绘勾选框：原生 checkbox 在沙箱 iframe 里会被画成浅色小方块，看不见
      var check = document.createElement("input");
      check.type = "checkbox";
      check.className = "todo-check";
      check.checked = item.done;
      check.title = item.done ? "标记为未完成" : "标记为已完成";
      check.setAttribute("aria-label", item.text);
      check.addEventListener("change", function () {
        item.done = check.checked;
        commit();
      });

      var text = document.createElement("span");
      text.className = "todo-text";
      text.textContent = item.text;
      text.title = item.text;

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "todo-remove";
      remove.textContent = "×";
      remove.title = "删除";
      remove.setAttribute("aria-label", "删除「" + item.text + "」");
      remove.addEventListener("click", function (event) {
        event.stopPropagation();
        items = items.filter(function (candidate) {
          return candidate.id !== item.id;
        });
        commit();
      });

      // 点整行都能勾：文字比那个小方框好点得多。
      // 勾选框和删除按钮自己处理过事件，这里要让开，否则状态会翻两次。
      li.addEventListener("click", function (event) {
        if (event.target === check || event.target === remove) return;
        item.done = !item.done;
        commit();
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
    commit();
  });

  call("storage.get", { key: STORAGE_KEY })
    .then(function (value) {
      if (touched) return;
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

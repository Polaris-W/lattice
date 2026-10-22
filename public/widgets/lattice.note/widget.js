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
    if (data.type === "store-changed") {
      var key = data.payload && data.payload.key;
      if (!key || key === "text") reloadText();
      return;
    }
    if (data.type !== "response") return;
    var entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) {
      entry.resolve(data.result);
    } else {
      var error = new Error(data.error || "Bridge call failed");
      error.code = data.code;
      entry.reject(error);
    }
  });

  // ---------- 业务 ----------
  var textEl = document.getElementById("text");
  var statusEl = document.getElementById("status");
  var countEl = document.getElementById("count");

  var timer = null;

  /*
   * 保存状态机
   *
   * 两个数字就够：
   *   revision  每次输入 +1，代表"用户想存的那一版内容"
   *   saved     已经确认落盘的版本
   *
   * 不这么写会出三种错，全都表现为"优先级搞反了"：
   *   1. 保存在飞的时候用户又敲了字，回调却把状态写成"已保存" —— 界面撒谎；
   *   2. 两次保存并发，旧的那次后完成，把新内容盖掉 —— 旧值赢了新值；
   *   3. 载入是异步的，用户先开始打字，磁盘上的旧内容回来把输入冲掉 ——
   *      磁盘赢了用户。
   */
  var revision = 0;
  var saved = 0;
  var saving = false;

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind ? "is-" + kind : "";
  }

  function updateCount() {
    countEl.textContent = Array.from(textEl.value).length + " chars";
  }

  function save() {
    // 上一次还没回来就什么都不做：它回来时会发现 revision 更大，自己再存一次
    if (saving || saved >= revision) return;
    saving = true;
    var target = revision;
    setStatus("Saving…", "");
    call("storage.set", { key: "text", value: textEl.value })
      .then(function () {
        saved = target;
        saving = false;
        if (revision > saved) {
          save();
          return;
        }
        setStatus("Saved", "saved");
      })
      .catch(function (error) {
        saving = false;
        setStatus(
          error.code === "permission_denied" ? "Storage permission not granted" : "Could not save",
          "error",
        );
      });
  }

  textEl.addEventListener("input", function () {
    revision += 1;
    updateCount();
    // 正在保存时别把"保存中…"改回"未保存"，那会让人以为存完了又退回
    if (!saving) setStatus("Unsaved", "");
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  });

  // 失焦立刻落盘，避免用户切走时最后 400ms 的输入丢掉
  textEl.addEventListener("blur", function () {
    clearTimeout(timer);
    save();
  });

  /**
   * 别的实例改了这份便签，重读一次。
   *
   * 什么时候不重读（本地优先，和保存状态机是同一套优先级）：
   *   - 还有没落盘的输入（revision > saved）：用户正在写，磁盘上的不能盖过来
   *   - 光标就在输入框里：同上，哪怕刚好存完了也别在人家打字时换内容
   */
  function reloadText() {
    if (revision > saved) return;
    if (document.activeElement === textEl) return;
    call("storage.get", { key: "text" })
      .then(function (value) {
        if (revision > saved) return;
        if (typeof value !== "string") return;
        if (value === textEl.value) return;
        textEl.value = value;
        updateCount();
        setStatus("Loaded", "saved");
      })
      .catch(function () {});
  }

  // 窗口被收走 / 页面隐藏时补一次。postMessage 是异步的，不保证一定送达，
  // 但比干等那 400ms 定时器强
  function flush() {
    if (revision <= saved) return;
    clearTimeout(timer);
    save();
  }
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });

  call("storage.get", { key: "text" })
    .then(function (value) {
      if (revision > 0) {
        // 用户在这几十毫秒里已经开始打字了：磁盘上的旧内容优先级最低
        updateCount();
        setStatus("Unsaved", "");
        return;
      }
      if (typeof value === "string") textEl.value = value;
      updateCount();
      setStatus("Loaded", "saved");
    })
    .catch(function (error) {
      if (revision > 0) return;
      updateCount();
      setStatus(
        error.code === "permission_denied" ? "Storage permission not granted" : "Could not load",
        "error",
      );
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();

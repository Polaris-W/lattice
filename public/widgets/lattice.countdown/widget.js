/**
 * 倒计时组件
 *
 * 第三方视角：不 import 平台任何东西，只通过 postMessage 跟宿主说话。
 * 时间一律向宿主索取（clock.now），不直接用本地 Date —— 桌面端将来
 * 可能要跟随系统时区变更，组件自己算会和平台漂移。
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
  var root = document.querySelector(".cd");
  var labelEl = document.getElementById("label");
  var daysEl = document.getElementById("days");
  var clockEl = document.getElementById("clock");
  var inputEl = document.getElementById("target");

  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }

  /** 默认目标：下一个 1 月 1 日 */
  function defaultTarget() {
    var now = new Date();
    return now.getFullYear() + "-01-01" > toDateString(now)
      ? now.getFullYear() + "-01-01"
      : now.getFullYear() + 1 + "-01-01";
  }

  function toDateString(date) {
    return (
      date.getFullYear() +
      "-" +
      pad(date.getMonth() + 1) +
      "-" +
      pad(date.getDate())
    );
  }

  function parseTarget(value) {
    var parts = String(value || "").split("-");
    if (parts.length !== 3) return null;
    var year = Number(parts[0]);
    var month = Number(parts[1]);
    var day = Number(parts[2]);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  }

  var target = null;

  function render() {
    if (!target) return;
    call("clock.now")
      .then(function (info) {
        var diff = target.getTime() - info.epochMs;
        var done = diff <= 0;
        var rest = Math.abs(diff);

        var days = Math.floor(rest / 86400000);
        rest -= days * 86400000;
        var hours = Math.floor(rest / 3600000);
        rest -= hours * 3600000;
        var minutes = Math.floor(rest / 60000);
        rest -= minutes * 60000;
        var seconds = Math.floor(rest / 1000);

        root.classList.toggle("is-done", done);
        labelEl.textContent = (done ? "已到达 · " : "距离 ") + target.getFullYear() + " 年 " +
          (target.getMonth() + 1) + " 月 " + target.getDate() + " 日";
        daysEl.textContent = String(days);
        clockEl.textContent = pad(hours) + ":" + pad(minutes) + ":" + pad(seconds);
      })
      .catch(function (error) {
        daysEl.textContent = "--";
        clockEl.textContent = "";
        labelEl.textContent =
          error.code === "permission_denied" ? "需要「读取系统时间」权限" : "读取失败";
      });
  }

  inputEl.addEventListener("change", function () {
    var next = parseTarget(inputEl.value);
    if (!next) return;
    target = next;
    render();
    call("storage.set", { key: "target", value: inputEl.value }).catch(function () {});
  });

  call("storage.get", { key: "target" })
    .then(function (value) {
      var parsed = typeof value === "string" ? parseTarget(value) : null;
      target = parsed || parseTarget(defaultTarget());
      if (typeof value === "string") inputEl.value = value;
      else inputEl.value = toDateString(target);
    })
    .catch(function () {
      target = parseTarget(defaultTarget());
      inputEl.value = toDateString(target);
    })
    .then(function () {
      render();
      setInterval(render, 1000);
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();

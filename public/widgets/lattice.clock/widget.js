/**
 * 时钟组件
 *
 * 注意：这里是"第三方视角"的代码，不 import 平台任何东西，
 * 只通过 postMessage 跟宿主说话。等 @lattice/sdk 发布后，
 * 下面这段 call / 主题同步会被 SDK 取代，组件业务代码不用改。
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
  var timeEl = document.getElementById("time");
  var dateEl = document.getElementById("date");
  var toggleEl = document.getElementById("toggle");

  var use24Hour = true;

  var WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function render() {
    call("clock.now")
      .then(function (info) {
        var date = new Date(info.epochMs);
        var hours = date.getHours();
        var suffix = "";
        if (!use24Hour) {
          suffix = hours < 12 ? " AM" : " PM";
          hours = hours % 12 || 12;
        }
        timeEl.textContent = (use24Hour ? pad(hours) : hours) + ":" + pad(date.getMinutes()) + suffix;
        // 中文的日期单位不跟数字隔空格："10月22日"，不是"10 月 22 日"。
        // 时区 ID（Asia/Shanghai）是给程序看的，桌面时钟上没人想读它，
        // 换成星期几，这块空间才算有用。
        dateEl.textContent =
          (date.getMonth() + 1) + "月" + date.getDate() + "日 " + WEEKDAYS[date.getDay()];
      })
      .catch(function (error) {
        timeEl.textContent = "--:--";
        dateEl.textContent = error.code === "permission_denied" ? "需要「读取系统时间」权限" : "读取失败";
      });
  }

  toggleEl.addEventListener("click", function () {
    use24Hour = !use24Hour;
    toggleEl.textContent = use24Hour ? "24小时制" : "12小时制";
    render();
    call("storage.set", { key: "use24Hour", value: use24Hour }).catch(function () {
      /* 存储权限被拒时只是不记忆偏好，不打断使用 */
    });
  });

  call("storage.get", { key: "use24Hour" })
    .then(function (value) {
      if (typeof value === "boolean") {
        use24Hour = value;
        toggleEl.textContent = use24Hour ? "24小时制" : "12小时制";
      }
    })
    .catch(function () {})
    .then(function () {
      render();
      setInterval(render, 1000);
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();

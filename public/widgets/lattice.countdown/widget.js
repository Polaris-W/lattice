/**
 * 倒计时组件
 *
 * 第三方视角：不 import 平台任何东西，只通过 postMessage 跟宿主说话。
 * 时间一律向宿主索取（clock.now），不直接用本地 Date —— 桌面端将来
 * 可能要跟随系统时区变更，组件自己算会和平台漂移。
 *
 * 目标日期不再由卡片上的原生日期控件决定，而是清单 `config` 里的一个
 * `date` 字段：属性面板渲染表单，值按实例存。以前那个 `<input type="date">`
 * 除了挤（卡片只有 156px 高），还得自己按底板亮度猜 `color-scheme`，
 * 否则深色卡片上日历图标是黑的。现在这两件事都不归组件管。
 *
 * 心跳同样走 `schedule.every`：窗口收起来时它就不跳了。
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

    // 属性面板改了目标日期 / 说明文字：就地重算，不重载组件
    if (data.type === "config-changed") {
      applyConfig(data.payload && data.payload.config);
      return;
    }

    if (data.type === "tick") {
      if (data.payload && data.payload.id === tickId) render();
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
  var root = document.querySelector(".cd");
  var labelEl = document.getElementById("label");
  var daysEl = document.getElementById("days");
  var clockEl = document.getElementById("clock");
  var tickId = 0;

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /** 出厂配置：目标为空 = 下一个 1 月 1 日，说明为空 = 自动写 "Until …" */
  var config = { target: "", label: "" };
  var target = null;

  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }

  /** 默认目标：下一个 1 月 1 日（含今天） */
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

  function applyConfig(next) {
    if (!next) return;
    config = {
      target: typeof next.target === "string" ? next.target : "",
      label: typeof next.label === "string" ? next.label : "",
    };
    // 配置里的日期非法（或为空）就退回"下一个元旦"，别让卡片停在 "--"
    target = parseTarget(config.target) || parseTarget(defaultTarget());
    render();
  }

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
        /*
         * 日期写成 "Jan 1, 2027"：英文习惯是月在前、日和年之间加逗号。
         * 用户自己写了说明（比如 "Christmas"）就整行换成它 —— 那种情况下
         * 再拼一句 "Until …" 只会把两句话挤在一起。
         */
        labelEl.textContent = config.label
          ? config.label
          : (done ? "Arrived · " : "Until ") +
            MONTHS[target.getMonth()] + " " + target.getDate() + ", " + target.getFullYear();
        daysEl.textContent = String(days);
        clockEl.textContent = pad(hours) + ":" + pad(minutes) + ":" + pad(seconds);
      })
      .catch(function (error) {
        daysEl.textContent = "--";
        clockEl.textContent = "";
        labelEl.textContent =
          error.code === "permission_denied" ? "Needs clock permission" : "Could not read the time";
      });
  }

  call("config.get")
    .then(function (values) {
      if (values) applyConfig(values);
    })
    .catch(function () {
      // 读不到配置就用出厂目标，至少还在倒计时
      target = parseTarget(defaultTarget());
    })
    .then(function () {
      render();
      return call("schedule.every", { every: 1000 });
    })
    .then(function (grant) {
      tickId = grant && typeof grant.id === "number" ? grant.id : 0;
    })
    .catch(function () {
      /* 心跳没挂上就停在这一帧 */
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();

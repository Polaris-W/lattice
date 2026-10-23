/**
 * 系统监视器组件
 *
 * 数据全部来自 `system.metrics`（需要 `system:monitor` 权限），
 * 心跳挂在平台的调度器上 —— 组件自己不碰 `setInterval`。
 *
 * 为什么用调度器而不是定时器：
 *   - 卡片被藏起来 / 主窗口最小化时，平台会把整条时间轴停掉，组件不用操心；
 *   - 同一个组件以后要是还需要别的心跳（比如每 5 秒算一次峰值），
 *     挂到同一条时间轴上还是一个计时器，而不是两个。
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
        "*",
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

  // ---------- 格式化 ----------

  function percent(ratio) {
    if (typeof ratio !== "number" || !isFinite(ratio)) return 0;
    return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  }

  function bytes(value) {
    if (!value || value < 0) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var at = 0;
    var rest = value;
    while (rest >= 1024 && at < units.length - 1) {
      rest /= 1024;
      at += 1;
    }
    /*
     * 三位数以上不再留小数：卡片就 240px 宽，多一位小数会把整行挤到换行。
     * 注意这里必须 `String(...)` —— `Math.round` 返回的是**数字**，直接往下
     * 走 `.replace` 会抛 "replace is not a function"。磁盘这种几百 GB 的量
     * 恰好每次都走这条分支，于是底栏那行网络数字永远停在占位符上（真撞过）。
     */
    var shown =
      rest >= 100 ? String(Math.round(rest)) : rest.toFixed(rest >= 10 ? 1 : 2);
    return shown.replace(/\.0+$|(\.\d)0$/, "$1") + " " + units[at];
  }

  function rate(value) {
    return bytes(value) + "/s";
  }

  // ---------- DOM ----------

  var el = {
    meta: document.getElementById("meta"),
    cpu: document.getElementById("cpu"),
    cpuBar: document.getElementById("cpu-bar"),
    mem: document.getElementById("mem"),
    memBar: document.getElementById("mem-bar"),
    memSub: document.getElementById("mem-sub"),
    disk: document.getElementById("disk"),
    down: document.getElementById("down"),
    up: document.getElementById("up"),
    hint: document.getElementById("hint"),
  };

  function setBar(node, ratio) {
    var value = Math.max(0, Math.min(1, ratio || 0));
    node.style.width = percent(value) + "%";
    node.classList.toggle("is-high", value >= 0.75 && value < 0.9);
    node.classList.toggle("is-critical", value >= 0.9);
  }

  function setHint(text) {
    el.hint.textContent = text || "";
    el.hint.classList.toggle("is-visible", !!text);
  }

  function render(metrics) {
    if (!metrics) return;

    setBar(el.cpuBar, metrics.cpu.usage);
    el.cpu.textContent = percent(metrics.cpu.usage) + "%";
    el.cpu.title = (metrics.cpu.cores || "?") + " logical cores";

    setBar(el.memBar, metrics.memory.usage);
    el.mem.textContent = percent(metrics.memory.usage) + "%";
    el.memSub.textContent = bytes(metrics.memory.used) + " of " + bytes(metrics.memory.total);

    el.disk.textContent = metrics.disk.mount + " " + percent(metrics.disk.usage) + "%";
    el.disk.title =
      bytes(metrics.disk.used) + " used of " + bytes(metrics.disk.total) + " on " + metrics.disk.mount;

    el.down.textContent = "↓ " + rate(metrics.network.rxPerSec);
    el.up.textContent = "↑ " + rate(metrics.network.txPerSec);
    el.down.title = bytes(metrics.network.rxTotal) + " received since boot";
    el.up.title = bytes(metrics.network.txTotal) + " sent since boot";
  }

  // ---------- 心跳 ----------

  var subscription = 0;
  var denied = false;
  var failures = 0;

  function refresh() {
    call("system.metrics")
      .then(function (metrics) {
        failures = 0;
        if (denied) {
          denied = false;
          setHint("");
        }
        render(metrics);
      })
      .catch(function (error) {
        if (error.code === "permission_denied") {
          denied = true;
          setHint("Needs the System metrics permission");
          return;
        }
        failures += 1;
        // 偶发失败（比如采样正卡在系统调用上）不吓人，连续三次才提示
        if (failures >= 3) setHint("Metrics unavailable");
      });
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__lattice !== 1) return;

    if (data.type === "theme") {
      applyTheme(data.payload);
      return;
    }
    if (data.type === "tick") {
      // 一条时间轴上可能挂着好几条心跳，认准自己那一条
      if (data.payload && data.payload.id === subscription) refresh();
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

  /*
   * 先打一拍再开始计时。
   *
   * 速率类指标（CPU 占用、网络吞吐）靠两次采样做差，Rust 侧第一次调用
   * 一定返回 0 —— 没有前值就编不出速率。所以启动时立刻调一次，把基线
   * 建立起来，第一次心跳（1 秒后）拿到的才是真数。
   */
  call("schedule.every", { every: 1000 })
    .then(function (grant) {
      subscription = grant.id;
      el.meta.textContent = "1s";
      refresh();
    })
    .catch(function () {
      setHint("Scheduler unavailable");
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();

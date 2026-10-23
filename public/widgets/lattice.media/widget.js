/**
 * 正在播放组件
 *
 * 第一个用 `media:control` 的组件：读 Windows 的 SMTC 会话（系统媒体传输控件），
 * 并且能按暂停 / 上一首 / 下一首。
 *
 * 几个决定：
 *
 *   1. **轮询而不是订阅**。WinRT 那边有事件（`MediaPropertiesChanged`），但要走
 *      COM 回调 + 一个活着的 STA 线程，代价远大于收益：这张卡片每两秒问一次
 *      "现在放的是谁"，用户完全看不出差别。间隔可以在属性面板里调。
 *
 *   2. **没会话不是错误**。`media.get` 在没有播放器时返回 `null`，这里显示
 *      "Nothing playing" 并把按钮灰掉 —— 桌面上没开播放器是常态，不该红字警告。
 *
 *   3. **按钮按下去立刻自己拨一下**。`media.control` 是异步的，等下一次轮询回来
 *      才更新图标的话，用户会以为没按到。所以先在本地翻转状态，轮询回来再校正。
 *
 *   4. **进度条只做展示**。SMTC 给的位置是"上次报告的时间戳"，播放中它会自己
 *      走。为了不每秒问一次系统，这里用本地时间插值：拿到位置的那一刻记下
 *      `at`，之后按经过的毫秒自己往前推。
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

  /** 毫秒 → `3:07` / `1:02:03`。超过一小时才出现小时位，卡片窄，能省则省 */
  function clock(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "0:00";
    var total = Math.floor(ms / 1000);
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var seconds = total % 60;
    var pad = function (value) {
      return value < 10 ? "0" + value : String(value);
    };
    if (hours > 0) return hours + ":" + pad(minutes) + ":" + pad(seconds);
    return minutes + ":" + pad(seconds);
  }

  // ---------- DOM ----------

  var el = {
    source: document.getElementById("source"),
    track: document.getElementById("track"),
    artist: document.getElementById("artist"),
    progress: document.getElementById("progress"),
    bar: document.getElementById("bar"),
    position: document.getElementById("position"),
    duration: document.getElementById("duration"),
    prev: document.getElementById("prev"),
    toggle: document.getElementById("toggle"),
    toggleGlyph: document.getElementById("toggle-glyph"),
    next: document.getElementById("next"),
    hint: document.getElementById("hint"),
  };

  /** 上一帧画出来的会话：属性面板改了"显示进度条"要拿它重画一遍 */
  var lastSession = null;

  var PLAY_ICON = '<path d="M5 3.2 12.4 8 5 12.8z" />';
  var PAUSE_ICON = '<path d="M5.2 3.4h1.8v9.2H5.2zM9 3.4h1.8v9.2H9z" />';

  function setHint(text) {
    el.hint.textContent = text || "";
    el.hint.classList.toggle("is-visible", !!text);
  }

  /**
   * 本地对"当前该不该显示暂停图标"的判断。
   *
   * 点一下之后系统那边可能还要几百毫秒才真的开始播，而下一轮轮询在两秒后。
   * 不本地翻转的话，那两秒里按钮一直是旧图标 —— 用户会以为点空了，再点一次，
   * 结果把它又按回去。
   */
  var optimistic = null;
  /** 进度插值用：上次从系统拿到位置的那一刻 */
  var positionAt = 0;
  var positionMs = 0;
  var playing = false;

  function render(session) {
    lastSession = session;
    if (!session) {
      el.source.textContent = "";
      el.track.textContent = "Nothing playing";
      el.artist.textContent = "";
      // 没有会话就整条收起来：留一条空槽加 "--:--" 看着像还没加载完
      el.progress.hidden = true;
      el.bar.style.width = "0%";
      el.position.textContent = "0:00";
      el.duration.textContent = "0:00";
      el.prev.disabled = true;
      el.toggle.disabled = true;
      el.next.disabled = true;
      el.toggleGlyph.innerHTML = PLAY_ICON;
      playing = false;
      optimistic = null;
      return;
    }

    el.source.textContent = session.source || "";
    el.track.textContent = session.title || "Unknown track";
    el.track.title = session.title || "";
    el.artist.textContent = [session.artist, session.album].filter(Boolean).join(" — ");

    var isPlaying = optimistic === null ? session.status === "playing" : optimistic;
    playing = isPlaying;
    el.toggleGlyph.innerHTML = isPlaying ? PAUSE_ICON : PLAY_ICON;
    el.toggle.title = isPlaying ? "Pause" : "Play";

    el.prev.disabled = !session.canPrevious;
    el.next.disabled = !session.canNext;
    // 能暂停 / 继续是"播不播得动"的唯一判据；有些播放器只给状态不给能力位
    el.toggle.disabled = !session.canPlayPause;

    positionMs = session.positionMs || 0;
    positionAt = Date.now();

    var duration = session.durationMs || 0;
    el.duration.textContent = duration > 0 ? clock(duration) : "--:--";
    el.position.textContent = clock(positionMs);
    // 没有时长（直播 / 某些播放器）就不画进度条：一条永远停在 0 的槽看着像坏了
    el.progress.hidden = !showProgress || duration <= 0;
    el.bar.style.width =
      duration > 0 ? Math.max(0, Math.min(100, (positionMs / duration) * 100)) + "%" : "0%";
  }

  /*
   * 进度条自己走。
   *
   * 只在播放中推进，并且到尾巴就停住 —— 让它越过右端再跳回来，比不动更像卡死。
   */
  var durationMs = 0;

  function tickProgress() {
    if (!playing || durationMs <= 0) return;
    var elapsed = Date.now() - positionAt;
    var shown = Math.min(durationMs, positionMs + elapsed);
    el.position.textContent = clock(shown);
    el.bar.style.width = (shown / durationMs) * 100 + "%";
  }

  // ---------- 轮询 ----------

  var subscription = 0;
  var denied = false;
  var failures = 0;
  var showProgress = true;
  var pollMs = 2000;

  function refresh() {
    return call("media.get")
      .then(function (session) {
        failures = 0;
        if (denied) {
          denied = false;
          setHint("");
        }
        // 轮询回来就是"系统说了算"：撤掉本地那个乐观值
        optimistic = null;
        durationMs = session && session.durationMs ? session.durationMs : 0;
        render(session);
      })
      .catch(function (error) {
        if (error.code === "permission_denied") {
          denied = true;
          render(null);
          setHint("Needs the Media control permission");
          return;
        }
        /*
         * `internal` = 桥自己抛的"只有桌面应用里能用"。浏览器预览（npm run dev）
         * 走的就是这条：画布能画，但 SMTC 在 WebView2 外面没有对应物。
         */
        if (error.code === "internal") {
          render(null);
          setHint("Media control needs the desktop app");
          return;
        }
        failures += 1;
        // 播放器刚启动 / 刚退出时 SMTC 会短暂报错，连续三次才提示
        if (failures >= 3) setHint("Media session unavailable");
      });
  }

  /** 换一个轮询间隔：先退掉旧的，再挂新的 */
  function reschedule(every) {
    var previous = subscription;
    subscription = 0;
    var done = previous
      ? call("schedule.clear", { id: previous }).catch(function () {})
      : Promise.resolve();
    return done
      .then(function () {
        return call("schedule.every", { every: every });
      })
      .then(function (grant) {
        subscription = grant.id;
        return refresh();
      })
      .catch(function () {
        setHint("Scheduler unavailable");
      });
  }

  function readConfig() {
    return call("config.get").then(function (config) {
      var next = Number(config && config.pollMs);
      pollMs = isFinite(next) ? Math.max(1000, Math.min(10000, next)) : 2000;
      showProgress = !config || config.showProgress !== false;
      el.progress.hidden = !showProgress;
    });
  }

  // ---------- 控制 ----------

  function control(action, local) {
    if (local) local();
    call("media.control", { action: action })
      .then(function (result) {
        // 系统说没做成（比如播放器已经退了）：立刻重读一次，别让界面停在假状态
        if (!result || result.ok !== true) {
          optimistic = null;
          return refresh();
        }
      })
      .catch(function (error) {
        optimistic = null;
        if (error.code === "permission_denied") {
          setHint("Needs the Media control permission");
        }
        return refresh();
      });
  }

  el.toggle.addEventListener("click", function () {
    var next = !playing;
    control("playPause", function () {
      playing = next;
      optimistic = next;
      el.toggleGlyph.innerHTML = next ? PAUSE_ICON : PLAY_ICON;
      el.toggle.title = next ? "Pause" : "Play";
    });
  });

  el.prev.addEventListener("click", function () {
    control("previous");
  });

  el.next.addEventListener("click", function () {
    control("next");
  });

  // ---------- 宿主消息 ----------

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__lattice !== 1) return;

    if (data.type === "theme") {
      applyTheme(data.payload);
      return;
    }
    if (data.type === "config-changed") {
      var config = data.payload && data.payload.config;
      var previousPoll = pollMs;
      var previousShow = showProgress;
      Promise.resolve()
        .then(function () {
          return readConfig();
        })
        .then(function () {
          if (showProgress !== previousShow) render(lastSession);
          // 间隔变了才重挂时间轴：每次改配置都重挂会漏掉一拍
          if (pollMs !== previousPoll) return reschedule(pollMs);
        });
      return;
    }
    if (data.type === "tick") {
      if (data.payload && data.payload.id === subscription) refresh();
      // 进度条自己走，不等心跳：心跳是两秒一拍，进度条要看起来是连续的
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
   * 进度条 250ms 一跳。
   *
   * 这个**不用**平台的调度器：调度器的间隔下限是 1000ms（见 runtime/schedule），
   * 而进度条一秒动一次会明显卡顿。它也不花 IPC —— 纯本地算术，窗口藏起来时
   * 浏览器自己会把定时器降到 1s 一次，代价可以忽略。
   */
  setInterval(tickProgress, 250);

  /*
   * 先读配置，再挂时间轴。
   *
   * 反过来的话第一次轮询用的是默认的 2 秒，而用户可能设的是 10 秒 ——
   * 启动那一下多问一次无害，但订阅的间隔错了就要等下次改配置才纠正。
   */
  readConfig()
    .catch(function () {})
    .then(function () {
      return reschedule(pollMs);
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();

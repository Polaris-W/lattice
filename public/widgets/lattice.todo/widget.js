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

  // ---------- 业务 ----------
  var STORAGE_KEY = "items";
  var items = [];

  /*
   * 优先级：三级，红 / 黄 / 绿，用一个小圆点表示。
   *
   * 点一下从"没设"开始依次是 红 → 黄 → 绿 → 没设。第一下给红，是因为
   * "这条重要"才是最常见的动作，别让人为了标个紧急先点两下。
   *
   * 没设的那一档画成空心圈而不是不画：一来整列对得齐，二来空心的圈
   * 本身就是"这儿可以点"的提示 —— 只在 hover 时才出现的按钮，用户
   * 永远发现不了。
   */
  var PRIORITY_ORDER = ["high", "med", "low"];
  var PRIORITY_LABEL = { high: "High", med: "Medium", low: "Low" };

  /** 磁盘上的老数据没有这个字段，也可能有脏值 —— 认不出来就当没设 */
  function readPriority(value) {
    return PRIORITY_ORDER.indexOf(value) >= 0 ? value : null;
  }

  function nextPriority(current) {
    if (!current) return "high";
    var at = PRIORITY_ORDER.indexOf(current);
    return at === PRIORITY_ORDER.length - 1 ? null : PRIORITY_ORDER[at + 1];
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
      var error = new Error(data.error || "Bridge call failed");
      error.code = data.code;
      entry.reject(error);
    }
  });

  var formEl = document.getElementById("form");
  var inputEl = document.getElementById("input");
  var listEl = document.getElementById("list");
  var emptyEl = document.getElementById("empty");
  var metaEl = document.getElementById("meta");

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

  /**
   * 落盘失败只在标题栏那一小格里说一句，不动输入框。
   * 以前是把提示写进 input.placeholder —— 出错一次，那句 "Add a to-do,
   * press Enter" 就永远回不来了。
   */
  var saveError = false;

  function paintMeta() {
    if (saveError) {
      metaEl.textContent = "Not saved";
      metaEl.classList.add("is-error");
      return;
    }
    metaEl.classList.remove("is-error");
    metaEl.title = "";
    if (items.length === 0) {
      metaEl.textContent = "";
      return;
    }
    var left = 0;
    items.forEach(function (item) {
      if (!item.done) left += 1;
    });
    metaEl.textContent = left === 0 ? "All done" : left + " left";
  }

  function persist() {
    writing += 1;
    call("storage.set", { key: STORAGE_KEY, value: items })
      .then(function () {
        if (!saveError) return;
        saveError = false;
        paintMeta();
      })
      .catch(function (error) {
        saveError = true;
        paintMeta();
        metaEl.title =
          error.code === "permission_denied" ? "Storage permission required to save" : "Could not save";
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
      check.title = item.done ? "Mark as not done" : "Mark as done";
      check.setAttribute("aria-label", item.text);
      check.addEventListener("change", function () {
        item.done = check.checked;
        commit();
      });

      var priority = readPriority(item.priority);
      var upcoming = nextPriority(priority);
      var dot = document.createElement("button");
      dot.type = "button";
      dot.className = "todo-dot";
      if (priority) dot.dataset.level = priority;
      dot.title = priority
        ? "Priority: " + PRIORITY_LABEL[priority] + " — click to change"
        : "Set priority";
      dot.setAttribute(
        "aria-label",
        (priority ? "Priority: " + PRIORITY_LABEL[priority] : "No priority") +
          ". Click to " +
          (upcoming ? "set " + PRIORITY_LABEL[upcoming].toLowerCase() : "clear it") +
          ".",
      );
      dot.addEventListener("click", function (event) {
        event.stopPropagation();
        // 重读一次而不是用闭包里的 priority：同一行被点了好几下时，
        // 闭包里那个值是上一轮渲染的，已经过期了
        var next = nextPriority(readPriority(item.priority));
        if (next) item.priority = next;
        else delete item.priority;
        commit();
      });

      var text = document.createElement("span");
      text.className = "todo-text";
      text.textContent = item.text;

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "todo-remove";
      remove.textContent = "×";
      remove.title = "Delete";
      remove.setAttribute("aria-label", "Delete \"" + item.text + "\"");
      remove.addEventListener("click", function (event) {
        event.stopPropagation();
        items = items.filter(function (candidate) {
          return candidate.id !== item.id;
        });
        commit();
      });

      // 点整行都能勾：文字比那个小方框好点得多。
      // 勾选框、优先级圆点和删除按钮自己处理过事件，这里要让开，否则状态会翻两次。
      li.addEventListener("click", function (event) {
        if (event.target === check || event.target === remove || event.target === dot) return;
        item.done = !item.done;
        commit();
      });

      li.appendChild(dot);
      li.appendChild(check);
      li.appendChild(text);
      li.appendChild(remove);
      listEl.appendChild(li);
    });

    /*
     * 只有真被省略号截断的行才挂 title。
     * 全都挂的话，鼠标扫过列表就一路弹系统那个白底黑框的原生提示框，
     * 内容还是屏幕上已经写着的那几个字 —— 在小卡片上特别扎眼。
     * 这里要等节点进树之后量，离树时 scrollWidth 恒等于 clientWidth。
     */
    Array.prototype.forEach.call(listEl.querySelectorAll(".todo-text"), function (el) {
      if (el.scrollWidth > el.clientWidth) el.title = el.textContent;
      else el.removeAttribute("title");
    });

    emptyEl.classList.toggle("is-visible", items.length === 0);
    paintMeta();
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

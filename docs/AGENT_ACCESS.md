# Agent 接入

> 一句话：**一个端点，三个接入面。** 底下那层（通道 + 身份 + 审计）是三项共用的，
> 它不对的话上面两层都要重写。

这份文档记录的是**已经做出来的**和**想清楚但还没做的**，两者分开写。看的时候先看每节
标题后面的状态标记：`[已实现]` / `[设计]`。

## 0. 先把三件事分开

"让 AI 调控桌面"这句话里其实有三件事，它们的风险、工作量、依赖完全不同：

| | 是什么 | 状态 | 要动什么 |
| --- | --- | --- | --- |
| **A 控制平面** | agent 摆组件、改布局、换主题、暂停 | `[已实现]` | 一条通道 + 一个新身份 + 审计 |
| **B 数据平面** | agent 读待办、加日历事件、查天气 | `[设计]` | 组件清单加一节 `agent.tools`，**所有组件作者要跟着改** |
| **C agent 当组件** | 一块看板：agent 刚才说了什么、改了什么 | `[已实现]` | 一个官方组件 + 一条 `say` 通道 + 一项新权限 |

顺序不能倒。B 要改组件规范（波及所有作者），C 依赖 A 已经能用；A 是地基。

## 1. A 控制平面 `[已实现]`

### 1.1 为什么是 HTTP，不是命名管道

命名管道不开端口、不弹防火墙，但只有 Windows 客户端能用 —— 而 agent 宿主可能跑在
WSL 里、可能是 `curl`、可能是某个 Go 写的 MCP 服务。HTTP 是唯一"任何东西都会说"的
协议。

代价是端口，所以四道约束：

- 只绑 `127.0.0.1`（不是 `0.0.0.0`，局域网连不上）
- 端口取 0，由系统分配 —— 不撞车，也不占一个固定号
- **默认关，关着的时候根本不 bind**（不是"绑上但拒绝"：端口开着就是开着了，拒绝逻辑写错一次就漏一次）
- 每个请求都要 Bearer 令牌，常量时间比对

### 1.2 为什么执行器在前端

布局的权威在 `useLattice` 的内存状态里，`state.json` 只是它的落盘副本（`state.rs`
是**整份覆盖**写）。所以 agent 的请求必须落在那份状态上。

任何"后端自己改 state.json"的捷径都会和前端内存里的那份打架 —— 这个项目已经被孤儿
进程这么咬过一次（内存里那份把磁盘上的新布局盖掉）。所以：

```
HTTP 请求 → agent.rs → emit `lattice:agent` → platform/agent.ts 执行 → agent_reply
```

后端**不解释结果**：前端给的 JSON 原样当响应体发回去。少一层转译，少一处会不一致。

### 1.3 协议

只有一个 `POST /rpc`，加一个 `GET /health`（也要令牌，这样"401"和"连不上"能分开）。

```jsonc
// 读
{"op": "state"}

// 改
{"op": "act", "action": "placement.move", "args": {"instanceId": "lattice.clock#a1b2", "x": 40, "y": 40}}

// 说一句（agent 唯一的"嘴"，直接进审计日志，不经过前端）
{"op": "say", "text": "Moved the clock to the top right"}

// 第二层，先占位（现在回 unsupported）
{"op": "tool", "instanceId": "…", "tool": "todo.add", "args": {"text": "buy milk"}}
```

响应统一是 `{"ok": true, "result": …}` 或 `{"ok": false, "code": "…", "error": "…"}`。

状态码只表达**传输层**的事：`200` 处理了（哪怕业务上失败）、`400` 请求本身不对、
`401` 令牌不对、`403` 动作在白名单外、`413` 太大、`503` 窗口没答上来。业务失败用
`ok: false` + `code`，别混在状态码里 —— 否则 agent 分不清"重试有用"和"重试也没用"。

### 1.4 动作白名单

**白名单，不是黑名单。** 新增动作必须同时改三处：`agent_policy.rs` 的 `ACTIONS`、
`platform/agent.ts` 的 `AGENT_ACTIONS`、这张表。`tests/agent.html` 钉着两张表一致。

| 动作 | 参数 | 干什么 |
| --- | --- | --- |
| `placement.add` | `widgetId` | 加一份，落位用 `nextFreeSlot`（和界面同一个算法） |
| `placement.move` | `instanceId, x, y` | 移动，坐标取整 |
| `placement.resize` | `instanceId, w, h` | 缩放，夹到清单的 `minW/minH` |
| `placement.remove` | `instanceId` | 删掉，留一份 `lastClosed` 让用户能撤销 |
| `placement.pin` | `instanceId, pinned` | 固定位置与大小 |
| `placement.front` | `instanceId` | 置顶 |
| `theme.set` | `theme` | `light` / `dark` / `system` |
| `widgets.pause` | `paused` | 暂停全部组件 |

### 1.5 永远不给的

写在这里不是为了拒绝（`parse_action` 本来就不认），是为了让"为什么不给"有地方写，
也让测试钉住"哪天有人加进来就红"：

| 动作 | 为什么 |
| --- | --- |
| `widget.grant` | **提权**。agent 能给自己授权，前面所有闸门就都白设了 |
| `widget.install` | 装组件 = 跑别人写的代码，必须人点 |
| `widget.uninstall` | 卸载会连备份一起清，不可撤销 |
| `config.set` | 用户亲手填的值，需要一次界面确认 —— v1 没有确认流，所以先不给 |
| `storage.write` | 组件数据没有 schema，agent 只能瞎猜键名 |
| `state.clear` | 一条命令清空用户桌面 |
| `agent.set_enabled` | 自己给自己开门 |

`config.set` 和"安装"这两条**不是永远不做**，是"缺一个确认流"。补确认流的时候，
通道应该是界面上的一张卡片（谁、要干什么、点同意/拒绝），不是对话框 —— 对话框会被
训练成无脑点掉。

### 1.6 威胁模型（别高估令牌）

令牌文件在 `%APPDATA%\com.iron-tom.lattice\agent\endpoint.json`，**同一个账户下的
任何进程都读得到**。它挡的是别的用户、以及从网络上过来的东西；挡不住你自己账户里
跑着的程序。

桌面应用做不到进程级隔离，所以真正的防线不是密码学，是这四条：

1. 默认关，开的时候是人在界面上按的
2. 动作只有 8 个，全是可见、可撤销的布局操作
3. 每一步都进 `agent/audit.log`（一行一条 JSON：`at` / `op` / `detail` / `status` / `ms`）
4. 危险动作（授权、安装、卸载、清空）不在白名单里，agent 连试都试不到

跟 ✕ 那个 `close-guard` 是同一个思路：不追求"证明它是好人"，只追求"它做不了坏事
而你不知道"。

### 1.7 怎么用

设置菜单里打开 **Agent access**（默认关）。打开后：

```bash
npm run agent -- state
npm run agent -- act theme.set --args '{"theme":"dark"}'
npm run agent -- act placement.add --args '{"widgetId":"lattice.clock"}'
```

任何能跑 shell 的 agent 都能用这三条。MCP 那一层是**薄适配**，不是主入口 ——
把业务逻辑写进 MCP server，换个宿主就要重写一遍。

## 2. B 数据平面 `[设计]`

组件把自己的能力声明成工具，agent 通过平台调用。这是长期真正的价值，但它是一次
**规范变更**，所以放到最后。

### 2.1 清单里加一节

```jsonc
{
  "id": "com.example.todo",
  "agent": {
    "tools": [
      {
        "name": "add",
        "description": "Add one item to the todo list",
        "params": { "text": "string" },
        "result": { "id": "string" }
      }
    ]
  }
}
```

组件侧收到一条 `agent-call`，回一条 `agent-result`（和现有心跳同一个 postMessage 通道）。

### 2.2 三个必须先回答的问题

**一、调哪个实例？** `lattice.weather` 可以同时摆三份（上海、东京）。工具调用必须带
`instanceId`，而 agent 得能从 `state` 里看到这些实例 —— 这就是快照里 `placements`
带 `instanceId` 的原因。

**二、组件没在跑怎么办？** 这是最容易漏的一条。三种情况都会让调用落空：窗口不存在
（只在画布上，而主窗口收起）、被暂停、被别的窗口完全挡住（`occlusion.rs` 会把心跳
停掉）。桥调用本身不是定时器，被挡住也能回；**但窗口不存在时没有宿主页，没人能答**。
所以 `tool` 要么能唤醒（先把窗口建出来），要么回一句能看懂的话，而不是超时。

**三、要不要单独的授权轴？** 组件的 `grants` 是"这个组件能不能联网"，不是"agent 能不
能操作它"。这两个必须分开：用户允许天气组件联网，不等于允许 agent 往里塞数据。建议
一条独立授权：**allow agent to call this widget's tools**，默认关，按 `widgetId` 记。

### 2.3 一条原则

**agent 永远不碰原始存储。** 组件的 `widget-store/<id>.json` 是用户的便签和待办，
没有 schema，agent 读了也只能瞎猜。要数据就走组件自己声明的工具 —— 由组件的代码决定
暴露什么、怎么解释。平台不当数据出口。

## 3. C agent 当组件 `[已实现]`

一个官方组件 `lattice.agent`，但它**不是聊天窗，也不带模型**。

这个决定值得写下来，因为它把一整套攻击面直接删掉了：没有 baseUrl、没有 API key、没有
`network` 权限、不碰网络。它只做一件事 —— 读审计日志，把 agent 刚才说了什么、改了什么
列出来。

### 3.1 为什么不是聊天窗

最初的设计是"模型在窗里指挥平台"。真做的时候发现它要付三笔钱，而且第三笔最贵：

1. 组件的配置里要存一个 API key（用户的，落在 `widget-store` 里）
2. 要开 `network` 权限，而 `network.fetch` 的主机白名单是给固定域名的 —— 让用户自己
   填 baseUrl，白名单就形同虚设
3. **有嘴就有手**。一个能发请求的组件，离"能改布局"只差一条桥方法；那条口子开出去
   以后收不回来

而它想解决的问题 —— "我看不见 agent 在干什么" —— 不需要模型就能解决。agent 宿主
（Claude Desktop / CLI / 任何会说 HTTP 的东西）本来就有自己的界面，它只是**说不出话**。

### 3.2 所以给了它一条 `say`

`{"op": "say", "text": "…"}` 是 agent 唯一的嘴。它不走前端往返 —— `agent.rs` 直接写进
`agent/audit.log`，和 `act` 那几行并排。理由很实在：说一句话不需要等窗口答上来，
窗口没开的时候这句话也该留下。

两条约束：

- **压成一行**。审计日志是 JSONL，多行内容会把后面每一行都拆坏。所以
  `say_text` 用 `split_whitespace().join(" ")` 压平。
- **超长拒绝，不截断**。上限 500 字符。截断等于替 agent 决定"后半句不重要"，而它会以为
  自己说完了。拒绝它，它下次会说短一点。

### 3.3 看板为什么骗不了人

`act` 那几行是**平台**写的，`say` 那几行是 agent 自己的话，两者在数据里就是不同的 `op`。
组件只负责显示，不解释、不执行、没有任何调用动作的接口 —— 它结构上做不了事，也就没法
被诱导去做事。

另外它需要一项新权限 `agent:activity`：审计日志里有用户的操作历史，白给不合适。

`agent` 关着的时候它照样显示历史（过去发生过的事不会因为关掉开关就变成没发生过），
只是不再有新行进来。

### 3.4 以后真要做聊天窗

那就得先回答上面第 3 条 —— 组件的"手"从哪来。两个选项：

- 给 `127.0.0.1` 在 `network.fetch` 上开个口子：等于给**任何**组件开
- 一条专用桥方法：更干净，但平台从此内置了一个"能改布局的组件"

两条都要等 B 的授权轴（`2.2` 第三条）做完，因为那时才有"agent 能做什么"这个概念可以复用。
现在不做。

## 4. 明确不做（v1）

**后台自主调控。** 比如"每天按天气自动换主题"——那需要一个常驻订阅，而人在环（用户说
一句、它做一次）和无人环是两套完全不同的安全模型。先把有人的那条做顺。

## 5. 验证

| 部分 | 怎么验 |
| --- | --- |
| `agent_policy.rs`（HTTP 解析 / 令牌 / 白名单 / `say`） | 26 条 `rustc --test`，见 `.scratch/agent-test.rs` |
| `platform/agent.ts`（动作执行器） | `tests/agent.html` 57 条，跑的是**真 store** |
| `scripts/lattice-agent.mjs`（客户端） | `npm run test:agent`，14 条，起假端点测请求形状、`say` 的整句传递与退出码 |
| `lattice.agent`（看板组件） | `tests/agent-widget.html` 50 条，iframe 里加载真组件，调 `window.__latticeAgentFeed` |
| Rust 监听器 + Tauri 往返 | **没验过** —— 要起 `tauri:dev`。起之前先确认没有残留的 `lattice.exe`（孤儿进程会用内存里那份盖掉 `state.json`） |

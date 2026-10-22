# 路线图

## v0.1 —— 骨架（已完成）

目标是把最贵的三个决定定死：组件包格式、桥协议、权限模型。

- [x] Tauri 2 + React 19 + TS 工程骨架
- [x] 组件清单校验与归一化（`runtime/manifest.ts`）
- [x] 组件注册表：内置（index.json）+ 用户安装（Rust 扫描）
- [x] 沙箱 iframe 运行时 + 来源校验的 RPC 桥
- [x] 权限闸门与逐项授予 UI
- [x] 画布：拖动、缩放、网格吸附、层级标记、鼠标穿透开关
- [x] Win32：`WS_EX_NOACTIVATE` / `WS_EX_TOOLWINDOW` / 穿透 / WorkerW 挂载 / 置顶
- [x] 组件包安装与卸载（Rust 命令，含 id 合法性校验）
- [x] 两个可运行的示例组件：时钟、待办
- [x] 明暗主题与主题令牌下发

## v0.2 —— 真桌面（进行中）

从"画布上的预览"变成"真的贴在桌面上"。

- [x] **每个组件一个 WebviewWindow** —— 由 Placement 派生真实窗口，主窗口最小化退场
- [x] **层级实机接入** —— `desktop.rs` 的 `apply_window_layer` 已接进窗口创建流程
- [x] **圆角** —— `SetWindowRgn` 把窗口裁成圆角矩形（见下方"踩过的坑"）
- [ ] **`lattice-widget://` 自定义协议** —— 让用户安装的组件能从磁盘加载，这是当前最大的缺口
- [ ] 多显示器与 PerMonitorV2 DPI 处理
- [ ] 托盘图标：显示设置、暂停全部组件、退出
- [ ] 组件加载失败的可视化错误卡片（当前是"待接入"占位）

验收标准：关掉主窗口后，桌面上的组件仍在，切窗口不被遮挡，点击不抢焦点。

### 踩过的坑（都已解决，别再踩）

| 症状                                                          | 真实原因                                                                                       | 解法                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 命令里调 `sync_widget_windows` 之后界面直接冻住，日志停在 `sync specs=N`，无报错 | Tauri 2 的**同步命令跑在主线程**，而 `WebviewWindowBuilder::build()` 要把建窗口的活儿投递回主线程再等它完成 —— 命令占着主线程等自己 | 命令改成 `async fn`，落到运行时线程池                                          |
| 同上，但表现为 `WebView2 error HRESULT(0x8007139F)`                | 持有 `Mutex<窗口表>` 去建窗口，新窗口的宿主页立刻回调 `widget_host_config` 抢同一把锁                                | 不维护窗口表，窗口存在性交给 `app.get_webview_window`；宿主页配置在 `build()` **之前**登记 |
| 主窗口一片白，`eval` 返回 Ok 但脚本没跑                                   | WebView2 的 GPU 进程起不来（混合显卡 + 虚拟显示适配器）                                                       | `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--in-process-gpu`          |
| 加上 `--disable-gpu-compositing` 后透明窗口建不出来                    | 该开关会关掉 DirectComposition，逐像素透明依赖它                                                          | 不要加这个开关                                                           |
| 组件窗口背景永远是白的，`transparent(true)` 无效                          | 逐像素透明要求 WebView2 走合成，软件渲染下拿不到；`DwmEnableBlurBehindWindow` 也压不住                             | 放弃逐像素透明：窗口不透明、宿主页自己画卡片、`SetWindowRgn` 裁圆角                         |
| `layer: desktop` 的组件跑到了最上层                                  | `window.show()` 在 `apply_to` 之后调用，ShowWindow 会把窗口重新提到最前                                    | 先 `show()` 再应用层级                                                  |
| 投放之后组件"消失"，`GetWindowRect` 显示在 -31000 一带                   | 主窗口最小化后 `window.screenX/screenY` 变成 `-32000` 哨兵值，防抖同步拿它重算画布原点，把窗口 `set_position` 到屏幕外      | 缓存上一次可信的原点，遇到哨兵值退回缓存                                             |
| `cargo build` 报 `export ordinal too large: 92606`           | `crate-type` 里有 `cdylib`，windows-gnu 要导出巨大符号表                                              | 只留 `rlib`                                                         |

### 环境与构建（windows-gnu）

默认工具链是 `stable-x86_64-pc-windows-gnu`，它不自带 `windres`，也没有 `gcc`，  
而 `tauri-build` 要用 `windres` 编译 `resource.rc`、`windres` 又要调 `gcc -E`。

`scripts/tauri.mjs` 在启动 `tauri` 之前把两个目录塞进 `PATH`：

```
.toolchain/mingw64/bin     # MSYS2 binutils 里的 windres.exe
.toolchain/gcc-shim        # 一个只做透传的 gcc.exe（见 toolchain/gcc-shim/gcc.rs）
```

`npm run tauri:dev` / `tauri:build` 都走这个包装脚本，所以直接跑就行。  
换到 MSVC 工具链（`rustup default stable-x86_64-pc-windows-msvc`）就不需要这一套了。

### 运行时开关

| 变量                                          | 作用                                      |
| ------------------------------------------- | --------------------------------------- |
| `LATTICE_GPU=1`                             | 不注入 `--in-process-gpu`，恢复 WebView2 默认行为 |
| `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=...` | 自己指定 WebView2 启动参数（优先级最高）               |

## v0.3 —— 平台能力

- [ ] 系统指标数据源：CPU / 内存 / 磁盘 / 网络（`system:monitor` 权限落地）
- [ ] 网络白名单代理（`network` 权限落地，组件不直连）
- [ ] 平台统一调度器：组件定时器集中管理，不可见时暂停
- [ ] 组件崩溃隔离与自动恢复
- [ ] 组件目录变更监听（拖入新组件自动刷新）
- [ ] 开机自启、单实例锁

## v0.4 —— 开发体验

- [ ] `@lattice/sdk` —— 把桥客户端、主题同步、类型定义封成包
- [ ] `create-lattice-widget` 脚手架
- [ ] 组件打包工具：目录 → `.lattice`（zip）
- [ ] 媒体控制权限（SMTC）
- [ ] 组件调试面板：实时日志、桥调用追踪

## v0.5 —— 分发

- [ ] 组件商店：远程 registry 索引 + 版本约束 + 签名校验
- [ ] 组件更新与回滚
- [ ] 组件评分与举报
- [ ] 权限变更提示（新版本申请了新权限时必须让用户重新确认）

## 长期要盯的风险

| 风险              | 说明                                                |
| --------------- | ------------------------------------------------- |
| **安全**          | 第三方组件是任意代码。沙箱 + 权限清单只是第一层，还要 CSP 锁定、网络白名单、签名校验    |
| **性能**          | 组件数量上去后，WebView 数量是内存杀手。需要考虑同一 WebView 内多组件，或空闲卸载 |
| **WorkerW 兼容性** | 挂桌面依赖未公开行为，Windows 大版本更新可能变。要有降级路径                |
| **组件生态冷启动**     | 平台价值取决于组件数量，早期需要官方做足够多高质量组件                       |

# Lattice

[![ci](https://github.com/unraveltao/lattice/actions/workflows/ci.yml/badge.svg)](https://github.com/unraveltao/lattice/actions/workflows/ci.yml)

An extensible desktop widget platform for Windows. Third parties write widgets in plain HTML / CSS / JS; the platform puts them safely onto the desktop.

> 棂 (líng) is the wooden lattice in a window pane. Every pane on your desktop is a widget that can grow there on its own.

English · [中文](./README.zh-CN.md)

## Status

v0.3 is a demo that **really sits on the desktop**. The platform ships empty: install the official pack, place widgets on the canvas, and each one runs for real inside a sandboxed iframe, calling platform capabilities over an RPC bridge with permissions granted one by one. Hit "Send to desktop" and every widget becomes a frameless window while the main window steps aside.

Once they are out there, windows can be dragged, resized and pinned, and both the layout and the widget data survive a restart. Closing the main window just tucks it away while widgets are on the desktop — `Quit Lattice` in the settings menu or on the tray is the real exit, and launching the app again brings the window back (single instance: the second launch wakes the first one instead of starting a duplicate). The avatar in the top-right opens settings: appearance, snap-to-grid, restore-on-launch, start-with-Windows, pause-all, and a local profile — signing in only writes to the local `state.json`, nothing is uploaded.

It also behaves like something that is supposed to stay running:

- **A tray icon**, so the app is reachable when the main window is hidden — open it, pause every widget, or quit
- **Start with Windows** (an opt-in `Run` entry, removed again on uninstall)
- **Pause all widgets** hides every desktop window in one click; the heartbeat stops with it, it does not just become invisible
- **A renderer crash reloads itself** — up to three times in a minute, then it stops trying and offers you a `Try again` bar instead of spinning
- **Saving a widget's files reloads it** in place, no restart, no clicking the reload button

Third-party widgets work too: drop a folder into the window and it is installed, copied into `%APPDATA%` and served over the `lattice-widget` protocol. [`examples/counter`](./examples/counter) is a sample you can drag straight in.

Both side panels collapse to a 40px rail when you want the whole canvas, and every package can ship its own icon: the library card, the canvas title bar and the inspector all draw it instead of a letter tile.

The current UI, with the settings menu open:

![The platform UI](docs/screenshot-settings.png)

## Widgets really sit on the desktop

![Widgets floating on the desktop](docs/screenshot-desktop.png)

A real screenshot: the note on the left, hidden behind a normal window, is `layer: desktop`; the to-do list in the middle, on top of that window, is `layer: top`; the countdown is on the right.

After "Send to desktop":

- Every Placement becomes its own `WebviewWindow` loading `widget-host.html`, which then hosts a sandboxed iframe — **the desktop window and the canvas preview run the same bridge and the same permission checks**, so there is no "works in preview, breaks on the desktop" fork
- `layer: desktop` widgets are parented to WorkerW (falling back to `HWND_BOTTOM`), below normal windows; `layer: top` widgets use `HWND_TOPMOST`
- Windows are frameless, stay out of the taskbar, use `WS_EX_NOACTIVATE` so they never steal focus, and are clipped to rounded corners with `SetWindowRgn`
- Dragging or re-layering on the canvas still moves the real window (120 ms debounced incremental sync)

## Desktop windows you can handle directly

![Desktop widget with its chrome](docs/screenshot-chrome.png)

Hover a widget on the desktop and a row of controls fades in at its top-right corner. These are **drawn by the host page, not by the widget** — a widget never has to think about how it gets moved:

| Icon | What it does |
| --- | --- |
| ⣿ Drag | Hold to move the window. Pointer capture keeps the drag alive even outside the window or the screen |
| ↓ / ↑ Layer | Toggle between "on the desktop" and "on top"; applies to the Win32 z-order immediately |
| ⚲ Pin | Lock position and size. While pinned, dragging and all eight resize handles are disabled and the cursor turns back to an arrow |
| ✕ Close | Close the window and remove the placement from the canvas (not just hide it) |

Eight resize handles hug the edges, with 18px of clearance at the corners: once the window is clipped to rounded corners, the pixels outside the arc do not belong to the window at all, so the handles have to sit inboard to be clickable.

On release the window rect is reported back to the main window and stored in `desktopRects`, which **takes priority on the next send** instead of recomputing from canvas coordinates.

## The backplate is yours to tune

![Three backplates](docs/screenshot-backplate.png)

Colour, fill and blur are per-instance sliders in the inspector — the widget itself never knows they exist:

- **Colour** — a swatch (native picker) plus R / G / B sliders, or `Auto` to follow the light / dark theme
- **Fill** — 0 to 1. Not window transparency: at `1` the card is solid, at `0` you see only frosted wallpaper
- **Blur** — 0 to 40 px, continuous

Text, muted text, borders and the accent colour all flip together based on how bright the resulting card is, so a white backplate gets dark type and a navy one gets light type — without touching widget code.

Under the hood the host page stacks three layers: a bitmap of the desktop (`PrintWindow(Progman)`, wallpaper and icons only, cropped to the window) blurred with CSS `filter: blur()`, an `rgba(tint, fill)` veil over it, and the widget iframe on top. The chrome pill keeps its own fixed neutral palette instead of following the backplate — it is platform UI, not your canvas.

## Options belong to the copy, not the widget

![Per-instance options in the inspector](docs/screenshot-options.png)

Anything a widget wants you to tune — 12/24-hour clock, target date, how many rows — is declared in its manifest and rendered by the inspector. The widget draws no settings UI of its own, and each copy on your desktop keeps its own values:

- Two clocks can run in different formats; two countdowns can point at different dates
- Changing an option updates the running widget in place — no reload, so a half-written note is never thrown away
- A value the manifest got wrong (out of range, wrong type, a date that does not exist) silently falls back to the shipped default instead of reaching the widget
- Five field types cover what widgets actually need: `toggle`, `number`, `text`, `select`, `date`

`Clock` and `Countdown` ship this way — the old in-card `24-hour` button and date picker are gone, and both now tick on the platform scheduler instead of `setInterval`, so they stop when the window is hidden.

## When a widget breaks, you can see why

![A missing file and a thrown exception](docs/screenshot-diagnostics.png)

A blank card used to be the only symptom, and it never told you whether the entry file was missing or your first line threw. Now there are two different answers:

- **A readable page instead of a blank body.** `File not found` / `Widget not installed` / `File could not be read`, with the widget id, the requested path, the folder that was searched, and what to fix. Sub-resource requests still get an empty body — handing HTML to `fetch("data.json")` only trades one confusing failure for another.
- **An error card for anything your script throws.** The host page can't read errors inside a sandboxed iframe (opaque origin), so the reporter is injected into the HTML at delivery time — by the protocol for widgets you install, by the build for the bundled ones. Same reporter source, so bundled and third-party widgets behave identically. Errors come back with message, `file:line:column` and a collapsible stack. Script exceptions outrank missing images — the image usually failed *because* of the exception.
- **Reload without restarting anything — usually without asking.** Saving a widget's files reloads it on its own: both widget roots are watched with `ReadDirectoryChangesW`, debounced to 300 ms of quiet (one save fires three or four change events, and a fixed timer would turn it into two reloads and a visible flicker). Only the widgets whose files changed are reloaded, so your half-written note is never thrown away. When you want it by hand: fifth button in the chrome pill, plus `Reload` on the error card and on the canvas strip.

The reporter is compressed to a single line before injection, because `event.lineno` counts lines in the document — a multi-line snippet would push every inline script's line numbers down (a real bug here: line 15 reported as `index.html:67:25`).

## A widget that dies comes back by itself

A sandboxed iframe is still a renderer process, and renderer processes die: a driver reset, an out-of-memory widget, a GPU hiccup. A blank card that stays blank until you notice is the wrong answer for something meant to live on your desktop for weeks.

`ICoreWebView2::add_ProcessFailed` gives the process failure kind, and the decision is deliberately narrow:

- **`render` and `gpu` are reloaded.** Those are the ones where rebuilding the webview actually fixes it
- **`browser` is not.** That is the whole WebView2 process; reloading would just crash again in place
- **Everything else is reported once** and left alone — no reload storms
- **At most three reloads per minute.** A widget that crashes on every load would otherwise become a once-a-second reload loop: CPU pegged, log flooded, and the user unable to work out which widget it is
- **After giving up, it tells you.** A bar appears at the bottom of the main window — `Clock keeps crashing — its window stopped reloading.` with a `Try again` button, because "silently gone" is the one outcome nobody can debug

The reload happens on a separate thread 120 ms later; rebuilding the window inside the failure callback deadlocks WebView2.

## The network is opt-in, per widget

Sandboxed widgets cannot reach the network by default — not through `fetch`, not by navigating. A widget that genuinely needs it declares hosts in its manifest and the user grants `network`; then every request goes out through the platform over the RPC bridge:

```json
{
  "permissions": ["network"],
  "network": { "hosts": ["api.example.com", "127.0.0.1:8787"] }
}
```

Three gates in order: the permission, then the host, then the request shape (method, ≤32 headers, ≤256 KB up, ≤1 MB down). Four decisions worth knowing:

- **No wildcards.** `*.example.com` would turn "this one endpoint" into "the whole domain", and the permission panel shows a single word — the user cannot audit what they allowed. List the hosts
- **The port is part of the identity.** `127.0.0.1:8787` is not `127.0.0.1`. Otherwise "let it reach my local dev server" means "let it reach every port on my machine"
- **Redirects are not followed** (`WINHTTP_OPTION_REDIRECT_POLICY_NEVER`). Following a 302 hands the whitelist to whoever owns the first host: allow `a.com`, and `a.com` forwards your payload to `evil.com`. The 302 comes back to the widget as a response, and if the widget wants to go there it has to pass the whitelist again
- **It goes over IPC, not a localhost proxy.** Opening a port on `127.0.0.1` would leave a path the widget can `fetch` directly, with nothing in the way; the bridge is a channel only the host page can speak on

This opens one door; it does not unlock the others. The widget CSP and the navigation intercept still hold, so a widget still cannot stuff data into a URL and navigate away with it.

## The layout is genuinely remembered

The platform does not persist through `localStorage`: on this machine WebView2 keeps it entirely in memory, and it is gone the moment the process exits. So state is written to files:

```
%APPDATA%\com.iron-tom.lattice\
  state.json                      placements, installed, grants, theme, desktop rects
  widget-data\lattice.note.json   per-widget storage, one file per package
```

Writes go through "temp file + atomic replace", so a power cut halfway through cannot leave a truncated JSON behind. Widget storage takes the same path (the `storage.get / set / remove` bridge methods sit on top of Rust file I/O), which is why the note text and the ticked to-dos are still there after a restart.

## How this project grew

From skeleton to genuinely-on-the-desktop in a single day. The code-size steps and every "torn down and rebuilt" are in the [ROADMAP](./docs/ROADMAP.md); here are the conclusions:

| Time | Milestone | Frontend / Rust / CSS (lines) |
| --- | --- | --- |
| 02:40 | Skeleton: manifest, bridge, permissions, canvas | 1,268 / 358 / 548 |
| 09:54 | First runnable demo | 1,553 / 358 / 680 |
| 11:22 | Widgets really on the desktop | 1,782 / 712 / 680 |
| 12:31 | Window chrome + file-backed state | 2,282 / 1,123 / 868 |
| v0.2 | Third-party protocol, typing, storage sync, settings, collapsible panels, widget icons | 3,433 / 1,649 / 1,834 |
| v0.3 | Tray, autostart, pause-all, live reload, crash recovery, network whitelist, mixed-DPI clamp | 6,469 / 5,716 / 2,561 |

More interesting than the numbers are the **six overturned decisions**: per-pixel transparency that could not work, a `localStorage` that never reached disk, `NOACTIVATE` making the note untypeable, the host page building the wrong URL for user widgets, two instances each holding their own list and eating the to-dos, and a self-managed window table that deadlocked itself. Each one records why it was chosen, what knocked it over, how it was fixed, and what it cost.

The 56 entries in "Pitfalls" are a by-product of the same process, and the most valuable part of this repository — they record the temper of this particular machine, not general dogma. One of them took an afternoon: `WinHttpSendRequest` takes its header length in **characters** while the registry APIs next door take **bytes**, and passing bytes makes every request with a custom header fail with nothing but `ERROR_INVALID_PARAMETER (87)`.

## The platform is empty

Open it for the first time and the desktop has nothing on it — like a fresh VS Code with no extensions.

- **The core contains no widgets**: canvas, window layer, widget host, permission system, install/uninstall, library, settings
- **Official widgets get no privileges**: the packages under `public/widgets` go through exactly the same manifest, sandbox and permission bridge as third-party ones. They are "already on your disk", not "compiled into the kernel"
- **Discovery ≠ installation**: `bundled` packages must be installed explicitly; `user` packages (under `%APPDATA%`) count as installed as soon as they exist on disk
- **The library is searchable**: one field above the list filters by name, id, description, author or permission — so "which widget can read system metrics?" is one word away

The full argument is in [ARCHITECTURE](./docs/ARCHITECTURE.md) (Chinese).

## Permissions are visible

When a widget hits a capability it has not been granted, the canvas shows a prompt and grants everything it needs in one go, after which the widget re-initialises:

![Permission prompt](docs/screenshot-permission.png)

The sandboxed iframe **omits `allow-same-origin`**, so widgets get an opaque origin: no access to the host DOM, no usable `localStorage`, and requests go out with `Origin: null`. Apart from the bridge, it can do nothing. The bridge authenticates by comparing `event.source` against the iframe reference rather than `event.origin` — every sandboxed iframe reports the origin string `"null"`, so it cannot tell instances apart.

`network` is the one permission that is not a single yes/no: it also needs a host list in the manifest, and the grant alone gets a widget nowhere (see [above](#the-network-is-opt-in-per-widget)). Every other permission maps to a bridge method, and the inspector greys out anything the platform does not implement yet instead of letting you grant something that would do nothing.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Shell / windows | Tauri 2 + `windows-sys` | A resident app is memory-sensitive, and Win32 behaviour has to be called directly |
| UI | React 19 + TypeScript | Matches the widget ecosystem |
| Build | Vite 8 | Fast, and aligned with the official Tauri template |
| State | Zustand + a custom persistence adapter | Platform state is shallow; the storage layer is swapped for files to dodge WebView2's in-memory `localStorage` |
| Styling | Plain CSS + CSS variables | A bespoke workspace is easier to control with a variable layer than with utility classes |
| Widget runtime | Sandboxed iframe + postMessage RPC | See [ARCHITECTURE](./docs/ARCHITECTURE.md) (Chinese) |

## Getting started

```bash
npm install
npm run dev           # browser demo: http://localhost:1420
npm run tauri:dev     # full desktop app (first run compiles Rust)
npm run tauri:build   # installer: src-tauri/target/release/bundle/nsis
```

Requirements: Node ≥ 20, a Rust toolchain, WebView2 (bundled with Windows 11).

> To just look at the demo, use `npm run dev` — no Rust needed. The desktop build currently needs `windres` (mingw binutils) or an MSVC toolchain; see the environment notes in the ROADMAP.

If you are taking over this repository (or you are a different model / person), read [AGENTS.md](./AGENTS.md) first: a one-page map, fourteen invariants, recipes for common changes, and the "do not half-fix" known gaps. It is written in Chinese, as are the design docs.

## Layout

```
AGENTS.md            Onboarding: read this first
LICENSE              MIT
src/
  platform/          Platform shell: canvas, library, inspector, settings, autostart, state
  runtime/           Widget runtime: manifest, registry, RPC bridge, scheduler, screen fit
public/widgets/      Official widget packages (only "available" until installed)
examples/counter/    Third-party sample (drag it in to install)
tests/               Self-check pages: 12 pages, 216 assertions, all in the browser
scripts/             Build helpers (widget index, toolchain PATH, diagnostics injection)
src-tauri/
  src/widgets.rs     Widget scanning / install / uninstall
  src/runner.rs      Runtime: Placement → real window incremental sync, chrome callbacks, pause
  src/protocol.rs    lattice-widget static file server (user widget HTML/CSS/JS)
  src/network.rs     Egress proxy over WinHTTP: permission → host whitelist → shape
  src/crash.rs       ProcessFailed handling: classify, count, reload, give up, tell the user
  src/watch.rs       Widget directory watching (ReadDirectoryChangesW, debounced)
  src/autostart.rs   HKCU Run entry: read, write, repair a stale path
  src/tray.rs        Tray icon: open / pause all / quit
  src/desktop.rs     Layering, rounded clipping, click-through, focus, z-order guard (Win32)
  src/state.rs       Platform state on disk (state.json, atomic replace)
  src/widget_store.rs Per-widget storage on disk (widget-data/<id>.json)
  installer-hooks.nsh NSIS hook: remove the Run entry on uninstall
docs/
  ARCHITECTURE.md    Architecture and trade-offs
  WIDGET_SPEC.md     Widget spec (read this to write one)
  ROADMAP.md         Progress, iteration timeline, overturned decisions, pitfalls
```

## Writing a widget

```
public/widgets/lattice.hello/
  manifest.json
  index.html
  icon.svg
  widget.js
```

```json
{
  "id": "lattice.hello",
  "name": "Hello",
  "version": "0.1.0",
  "entry": "index.html",
  "icon": "icon.svg",
  "size": { "w": 200, "h": 100, "minW": 120, "minH": 60 },
  "layer": "desktop",
  "permissions": ["clock"]
}
```

Widgets call platform capabilities with `parent.postMessage({ __lattice: 1, type: "request", id, method, params }, "*")`; the full protocol is in [WIDGET\_SPEC](./docs/WIDGET_SPEC.md). Run `npm run widgets:index` afterwards so the platform discovers the new widget.

**Widgets that are not shipped with the app need no repository change**: drag the whole folder from Explorer into a Lattice window and it is installed — files are copied to `%APPDATA%\com.iron-tom.lattice\widgets\<id>\` and loaded over the `lattice-widget` protocol. [`examples/counter`](./examples/counter) is a sample you can drag straight in.

## License

[MIT](./LICENSE)

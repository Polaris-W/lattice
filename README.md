# Lattice

[![ci](https://github.com/unraveltao/lattice/actions/workflows/ci.yml/badge.svg)](https://github.com/unraveltao/lattice/actions/workflows/ci.yml)

An extensible desktop widget platform for Windows. Third parties write widgets in plain HTML / CSS / JS; the platform puts them safely onto the desktop.

> 棂 (líng) is the wooden lattice in a window pane. Every pane on your desktop is a widget that can grow there on its own.

English · [中文](./README.zh-CN.md)

## Status

v0.2 is a demo that **really sits on the desktop**. The platform ships empty: install the official pack, place widgets on the canvas, and each one runs for real inside a sandboxed iframe, calling platform capabilities over an RPC bridge with permissions granted one by one. Hit "Send to desktop" and every widget becomes a frameless window while the main window steps aside.

Once they are out there, windows can be dragged, resized and pinned, and both the layout and the widget data survive a restart. The avatar in the top-right opens settings: appearance, snap-to-grid, and a local profile — signing in only writes to the local `state.json`, nothing is uploaded.

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

## When a widget breaks, you can see why

![A missing file and a thrown exception](docs/screenshot-diagnostics.png)

A blank card used to be the only symptom, and it never told you whether the entry file was missing or your first line threw. Now there are two different answers:

- **A readable page instead of a blank body.** `File not found` / `Widget not installed` / `File could not be read`, with the widget id, the requested path, the folder that was searched, and what to fix. Sub-resource requests still get an empty body — handing HTML to `fetch("data.json")` only trades one confusing failure for another.
- **An error card for anything your script throws.** The host page can't read errors inside a sandboxed iframe (opaque origin), so the protocol injects a small reporter into the HTML it serves. Errors come back with message, `file:line:column` and a collapsible stack. Script exceptions outrank missing images — the image usually failed *because* of the exception.
- **Reload without restarting anything.** Fifth button in the chrome pill, plus `Reload` on the error card and on the canvas strip. Save the file, hit reload, see the change.

The reporter is compressed to a single line before injection, because `event.lineno` counts lines in the document — a multi-line snippet would push every inline script's line numbers down (a real bug here: line 15 reported as `index.html:67:25`).

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
| Now | Third-party protocol, typing, storage sync, settings, collapsible panels, widget icons | 3,433 / 1,649 / 1,834 |

More interesting than the numbers are the **six overturned decisions**: per-pixel transparency that could not work, a `localStorage` that never reached disk, `NOACTIVATE` making the note untypeable, the host page building the wrong URL for user widgets, two instances each holding their own list and eating the to-dos, and a self-managed window table that deadlocked itself. Each one records why it was chosen, what knocked it over, how it was fixed, and what it cost.

The 28 entries in "Pitfalls" are a by-product of the same process, and the most valuable part of this repository — they record the temper of this particular machine, not general dogma.

## The platform is empty

Open it for the first time and the desktop has nothing on it — like a fresh VS Code with no extensions.

- **The core contains no widgets**: canvas, window layer, widget host, permission system, install/uninstall, library, settings
- **Official widgets get no privileges**: the packages under `public/widgets` go through exactly the same manifest, sandbox and permission bridge as third-party ones. They are "already on your disk", not "compiled into the kernel"
- **Discovery ≠ installation**: `bundled` packages must be installed explicitly; `user` packages (under `%APPDATA%`) count as installed as soon as they exist on disk

The full argument is in [ARCHITECTURE](./docs/ARCHITECTURE.md) (Chinese).

## Permissions are visible

When a widget hits a capability it has not been granted, the canvas shows a prompt and grants everything it needs in one go, after which the widget re-initialises:

![Permission prompt](docs/screenshot-permission.png)

The sandboxed iframe **omits `allow-same-origin`**, so widgets get an opaque origin: no access to the host DOM, no usable `localStorage`, and requests go out with `Origin: null`. Apart from the bridge, it can do nothing. The bridge authenticates by comparing `event.source` against the iframe reference rather than `event.origin` — every sandboxed iframe reports the origin string `"null"`, so it cannot tell instances apart.

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

If you are taking over this repository (or you are a different model / person), read [AGENTS.md](./AGENTS.md) first: a one-page map, five invariants, recipes for common changes, and the "do not half-fix" known gaps. It is written in Chinese, as are the design docs.

## Layout

```
AGENTS.md            Onboarding: read this first
LICENSE              MIT
src/
  platform/          Platform shell: canvas, library, inspector, state
  runtime/           Widget runtime: manifest validation, registry, RPC bridge
public/widgets/      Official widget packages (only "available" until installed)
examples/counter/    Third-party sample (drag it in to install)
tests/               Self-check pages: concurrent bridge writes, note save races
scripts/             Build helpers (widget index, toolchain PATH)
src-tauri/
  src/widgets.rs     Widget scanning / install / uninstall
  src/runner.rs      Runtime: Placement → real window incremental sync, chrome callbacks
  src/protocol.rs    lattice-widget static file server (user widget HTML/CSS/JS)
  src/desktop.rs     Layering, rounded clipping, click-through, focus, z-order guard (Win32)
  src/state.rs       Platform state on disk (state.json, atomic replace)
  src/widget_store.rs Per-widget storage on disk (widget-data/<id>.json)
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

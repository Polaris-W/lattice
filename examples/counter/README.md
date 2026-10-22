# Example: Counter

A minimal third-party widget that exercises the whole install path:

- Installing from disk (drag the folder into the window)
- Loading HTML / CSS / JS over the `lattice-widget` protocol
- Receiving theme tokens (`--surface`, `--fg`, …)
- Requesting the `storage` permission and reading/writing private storage

## Try it

Drag this **folder** (not the files inside it) from Explorer into a Lattice window. The widget library confirms the install; then click the "Counter" card to place it on the canvas. The first click on `+1` asks for permission — once granted, the count is persisted.

## Layout

```
counter/
  manifest.json   id, entry, icon, size, requested permissions
  index.html      markup; only relative asset paths
  icon.svg        shape only — the platform masks it and paints it with the current text colour
  style.css       colours come from --surface / --fg style variables, so it follows the theme
  widget.js       bridge client + business logic; imports nothing from the platform
```

## What to change

- `manifest.json`: `id` must be your own (lowercase letters, digits, `.` and `-` only) and
  must match the folder name, or installs get mixed up.
- To read other data, extend `permissions` and call `call("<method>")` from `widget.js`.
  The method table is in `docs/WIDGET_SPEC.md` §4.
- Never hard-code colours. The platform pushes the current `--lattice-*` values with a
  `theme` message; `THEME_MAP` in `widget.js` maps them onto the widget's own variables.

# AGENTS.md

A command palette for **herdr-app**, written as a herdr-app mod named `atd-launcher`.

## Source of truth

`docs/BEHAVIOR-SPEC-v2.md` decides what the palette does. Rules:

1. **Spec first.** A behavior change goes into the spec, then into code, in the same commit.
2. **Code that disagrees with the spec is a bug**, unless herdr-app makes the spec impossible. In that case write the difference into the spec (next to the behavior it changes) rather than only in code or here.
3. Open questions go to the user; record the answer in the spec. Don't leave decisions only in code comments or chat.
4. This file is about *how to work on it*; it never restates behavior.
5. Bump `updated:` in the spec's frontmatter to today's date whenever the spec changes.

## Herdr background

- herdr-app is the desktop window; herdr-core (`hc`) runs the terminals. Read `herdr-app --skill` and `hc --skill` for the current manuals. The old `herdr` TUI and its plugins are not this.
- The real API reference is generated on every app start: `~/.config/herdr-app/AGENTS.md`, `herdr.d.ts` (data and commands) and `gpui-kit.d.ts` (UI elements). Grep the `.d.ts` files before using an element method; don't guess. Never edit them.
- `herdr-app commands` lists every host command with its arguments (names and `required` only, no types).

## Layout

```
docs/BEHAVIOR-SPEC-v2.md   the spec (source of truth)
mod/main.js                the View: screen stack, keys, flows, rendering (imports "herdr")
mod/mod.json               overlay spec used by mod.open
mod/lib/fuzzy.js           §4.3 search scoring                 ┐
mod/lib/config.js          §8 parse/defaults/edits of the file │ pure: no "herdr" imports,
mod/lib/model.js           §4 sections and rows                │ tested with node
mod/lib/hostactions.js     §6.4 host actions, input inference  │
mod/lib/keys.js            §3/§6.1 per-platform keys and hints ┘
test/*.test.js             node:test for mod/lib
scripts/sync.sh            copy mod/ into herdr-app's mods folder
```

Keep anything testable in `mod/lib/` and free of `herdr`/`gpui-*` imports; `main.js` passes live data in.

## How main.js works

- Screens form a stack (`this.stack`); the main list is the bottom. `list` screens have `build() → sections`, `onEnter`, optional `onTab`/`onMove`; `prompt` and `record` screens edit text / capture a keystroke.
- Flows are async: `await this.pick(...)`, `this.prompt(...)`, `this.confirm(...)` push a screen and resolve on Enter (value) or Esc (`null`). `this.steps(cx, [fn...])` chains inputs: a step returns `BACK` to go to the previous one; a thrown error shows the Error screen and repeats the same step with what was typed kept.
- Menu items are `{ label, icon, color, act(cx) }`. Enter runs the first item. An `act` that returns a string after a settings change pops the menu and shows it as the status line. Actions that leave the palette call `this.close()` and then `run(...)`.
- Text fields are gpui-base `Input`s (`this.fields`: one `InputState` per placeholder), so input methods, selection and paste work. The field keeps letters, Backspace, ←/→ and plain Enter (its `submit` → `enter()`); other keys bubble to the root's `on_key_down` → `onKey`, which must `stop_propagation` only for keys it uses, or typing breaks. After changing `this.stack`, call `syncField()` (`push`, `finish`, `back` do).
- The config is read on open; `this.save(raw => edit)` re-reads, refuses if the file changed on disk, applies a `lib/config.js` edit and writes with `writeTextFile`'s stale check.

## Dev loop

```sh
npm test                                              # pure modules
./scripts/sync.sh                                     # copy mod/ → ~/.config/herdr-app/mods/atd-launcher
herdr-app check ~/.config/herdr-app/mods/atd-launcher # must pass before calling anything done
herdr-app status                                      # overlays, mod errors
herdr-app shot /path/in/scratchpad.png                # look at it
```

- Edit `mod/` in this repo only; never edit the copy in `~/.config/herdr-app/mods/atd-launcher`. A symlink there is **not** watched by herdr-app, which is why sync copies the files.
- An open palette keeps its old code. Close it and open it again: `herdr-app do mod.open --name atd-launcher` toggles it (check `herdr-app status` first to know which way you're toggling).
- `check` doesn't run virtual-list row renderers. Row bugs only show in the real window (for example, `on_click` isn't allowed inside a virtual list's rows: use `on_item_click` on the list).
- The person may be working in that window. Opening the palette takes their keyboard focus, and a stray Enter runs the default action. Ask before opening it, close it when done, and never send synthetic keys or pointer events to their display. Keyboard behavior is tested by the person.

## Gotchas

- Never keep a `cx` across callbacks; use the one each callback or `cx.spawn` task gets.
- No `setTimeout`; use `cx.timer`. Animate with `.loop`/`.frames`, not redraw timers.
- Use `theme()` colors. In the current theme `selected` ≈ `popover`, so highlight with `hover`.
- Element sizes (`h()`, text) follow the app zoom, but `v_virtual_list` item sizes don't: multiply them by `settings().zoom` or rows overlap.
- `run()` returns nothing. To get created ids you'd need `exec("herdr-app", ["do", ...])`.
- The `keys.json` edit for the shortcut must keep the person's other bindings untouched.

## Commits

Small commits, spec and code together, `npm test` and `herdr-app check` passing.

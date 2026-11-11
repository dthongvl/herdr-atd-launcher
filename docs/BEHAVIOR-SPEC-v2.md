---
title: Command Palette — Behavior & Experience Spec (v2)
status: draft for review
updated: 2026-11-11
tags: [spec, command-palette, ux]
---

# Command Palette — Behavior & Experience Spec (v2)

> [!abstract]
> What the user sees and what happens, not how it's built. **This is the source of truth** for the `atd-launcher` herdr-app mod: change behavior here first, then the code. Where herdr-app forces a difference, the difference is written here too.

## 1. Concepts

| Concept                | Meaning                                                                                                                                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Space / Tab / Pane** | A workspace (usually tied to a folder) / a tab inside it / a terminal inside a tab                                                                                                                                                                                                              |
| **Agent**              | A coding agent (Claude, Codex, Pi…) running in a pane                                                                                                                                                                                                                                           |
| **Current**            | The pane, tab or space that had focus when the palette opened                                                                                                                                                                                                                                   |
| **Saved space**        | A label + folder, with optional **space commands**                                                                                                                                                                                                                                              |
| **Saved command**      | A label + command text. **Global** (shown everywhere; agent launchers like `claude` are global commands) or a **space command** (shown only in its space, §6.3)                                                                                                                                 |
| **Quick action**       | An ordered pin to a built-in (`New tab`, `New space`), saved command, saved space or host action. Pins are references, so editing an item updates its pin. A pin can have its own label and otherwise behaves exactly like the item it points to (§6.1). Running agents and open spaces can't be pinned |
| **Host action**        | One of the host app's own operations, e.g. "Pane: Split"                                                                                                                                                                                                                                        |

Default quick actions: `+ New Claude tab` (`claude`) · `+ New tab` · `+ New space`.

## 2. Principles

1. **One shortcut, one list** of every target and action, fuzzy-searchable.
2. **The common case is two keystrokes:** shortcut, Enter → new agent tab. The current item is sorted first and is the default. Global commands ask for a space on Enter by default (§6.1, the *ask for space* setting), so the default `+ New Claude tab` is shortcut, Enter, Enter (the picker lists the current space first); ⌘Enter is the one-step new tab, and turning *ask for space* off on a command makes Enter the one-step new tab.
3. **One set of run keys everywhere:** Enter / ⌘ / ⇧ / ⌘⇧ + Enter mean the same four destinations on every row that runs something (§6.1).
4. **Ask only what's needed;** prefill what can be guessed.
5. **Safe by default:** anything that closes, removes, stops, disables or unlinks asks first (`No` is the default, Esc means No). A command is never typed into a busy pane without asking.
6. **Configurable in place.** A config file is recommended (it's how the palette knows your spaces and commands), but the palette still works without one.

## 3. Opening and closing

- **Shortcut:** ⌘T (`cmd-t`) on macOS, `Ctrl+T` (`ctrl-t`) on Linux and Windows. Configurable. Pressing it again closes the palette. In herdr-app the shortcut is a `keys.json` global binding to `mod.open:atd-launcher`; the config file's `shortcut` is written there each time the palette opens, so the file wins.
- **⌘ on Linux and Windows:** herdr-app spells the Super / Windows key `cmd`, and the desktop usually takes those chords before the app sees them (terminals swallow ⌘ keys too). So `Alt` stands in for `⌘` in every run key on every platform (`Alt+Enter` = `⌘Enter`, `Alt+Shift+Enter` = `⌘Shift+Enter`), and the key hints (footer, Tab menu, the record screen's example) show `⌘` on macOS and `Alt` / `Ctrl` on Linux and Windows. The footer always shows keys that work, and Settings warns when a chosen shortcut can't be received (on Linux and Windows: any `cmd-…` shortcut).
- **Overlay kind:** herdr-app closes a `dialog` on Esc before the mod sees the key, so Esc could never go back. The palette is therefore a `window` overlay (Esc goes to the mod, no dimming, a click beside it does not close it). Close with Esc on the main list, `Ctrl+C`, or the shortcut again.
- **Focus on close:** the palette takes the keyboard while open, and herdr-app doesn't hand it back when a window overlay closes. So every close first focuses the *current* pane again (the one that had focus when the palette opened, if it still exists): Esc, `Ctrl+C` and the shortcut leave you typing where you were, and *Run here* leaves you in the terminal it typed into. Actions that go somewhere else (new tab, right pane, switch space, focus agent…) then move focus on as usual.
- **Config rows show at once;** live sections show `Loading…` until their data arrives.
- **Closes:** any successful run, focus or create, and Open config file.
- **Stays open:** settings changes, cancels, and failures (the error is shown, then the user is back where they were, with inputs kept).

## 4. The main list

```text
Command Palette
> query_

Quick Actions
› + New Claude tab                       claude
  + New tab
  + New space
Agents
  ◐ api        codex — add rate limit    waiting for input
  ● web        claude — fix login bug    working
Commands
  ▸ Dev server                           web · pnpm dev -p 3001
  ▸ Codex                                global · codex
Spaces
  ● web                                  ~/code/web
  → api                                  ~/code/api
  → web                                  ~/code/web    (saved)
  → api                                  ~/code/api    (saved)
  + docs                                 ~/code/docs   (saved)
Settings
  …
Pane
  …

Enter choose space · ⌘↵ new tab · ⇧↵ right pane · ⌘⇧↵ here · Tab more    42/120
```

`42/120` = rows matching the search / all rows. The key hints in the footer follow the selected row: only the keys that do something on it are shown (a saved space shows `Enter open · ⌘↵ new copy · Tab more`).

### 4.1 Sections

Shown in this order; empty sections are hidden. Each section puts the current item first.

1. **Quick Actions:** the user's pins, in order. A pinned space command shows only in its space. Pinned items also appear in their own section.
2. **Agents:** ones waiting for input go above the current one.
3. **Commands:** the current space's commands, then global ones.
4. **Spaces:** open spaces, then all saved spaces. A saved space that's open is listed twice: once as open, once as saved. Open and saved spaces are matched by folder, never by label.
5. **Settings** (§7).
6. **Host actions:** one section per category, e.g. `pane.wait_for_output` → "Pane: Wait For Output".

### 4.2 Icons

| `●` current/default (green) | `◐` agent waiting (yellow) | `+` creates (green) | `▸` runs here | `→` switches focus | `−` closes/removes (red) | `✎` / `⧉` edit/copy |
| --- | --- | --- | --- | --- | --- | --- |

Each row starts with a 2-character icon slot so text lines up. Long lines are cut with `…`; the selected row's highlight must survive the cut. The selected row (moved by the arrow keys or set by a click) has the strong highlight. The row under the mouse gets a fainter one, so the two can't be confused; hover doesn't move the selection (herdr-app gives virtual-list rows no hover event, and its hover state can go stale and leave a faint highlight behind). Highlights of neighbouring rows never touch. Moving the selection scrolls the list so the selected row stays on screen; when moving up onto a section's first row, the section header comes into view too.

### 4.3 Search

Fuzzy, case-insensitive, characters in order. Ranks higher: word-start matches, consecutive characters, shorter text. Commands (and pins to commands) get a fixed bonus, so they rank above spaces that match about equally; a clearly better match still wins. Also matches folders, command text, agent/tab names and method names. While searching, headers hide, results form one ranked list with a dim type tag (`Agent`, `Command`…), and pinned items appear once.

While searching, each row also gets a color **type icon** between its action icon (§4.2) and its label, so kinds stay easy to tell apart in the mixed list: 🤖 agent · ⚡ command · 📁 space (open or saved) · ⚙️ setting · 🧩 host action · ✨ built-in quick action (`New tab`, `New space`). A pin shows the icon of what it points to. Without a query the section headers do this job, so there's no type icon.

```text
> cla_
● 🤖 web         claude — fix login bug     working     Agent
▸ ⚡ Claude       global · claude                        Command
→ 📁 claude-cfg   ~/code/claude-cfg                      Space
```

## 5. Keys

| Key | Where | Action |
| --- | --- | --- |
| type, `Backspace`, `Ctrl+U` | search, prompts | Edit / clear. The search box and prompts are herdr-app's native text field (gpui-base `Input`), so input methods (IBus Bamboo…), selection, copy and paste work as in any other field |
| `↑` `↓` `Ctrl+P` `Ctrl+N` `PgUp` `PgDn` | lists | Move. `↑` on the first row goes to the last and `↓` on the last goes to the first; `PgUp`/`PgDn` stop at the ends |
| `←` `→` `Home` `End` | search, prompts | Move the cursor (the native field's own editing keys) |
| `Enter` | anywhere | Do the default (§6.1: *choose space* on runnable rows, else the first item of the row's menu). In Manage quick actions, Enter opens the pin's options instead |
| `⌘Enter` / `Alt+Enter` | runnable rows | New tab in the same space |
| `Shift+Enter` | runnable rows | Right pane of the current tab |
| `⌘Shift+Enter` / `Alt+Shift+Enter` | runnable rows | Here: type into the current terminal |
| `Tab` | rows | More options: every action of the row, each with its shortcut shown on the right |
| `Shift+↑↓` | Manage quick actions | Move a pin (saves immediately) |
| `Esc` | anywhere | Back one step: clear the search → previous screen (search and selection restored) → close. The header always names what Esc will do now ("Esc clear search", "Esc back to <screen>", "Esc close") |
| `Ctrl+C` | anywhere | Close |
| click / right-click | rows | Same as plain `Enter` / `Tab`. Modifiers don't apply to clicks |

On rows that don't run anything (settings, open spaces, agents, host actions, pickers, prompts) the modifier + Enter keys do the same as Enter. In a text field Enter arrives as the field's *submit*, which reports Shift and the platform's secondary modifier (⌘ on macOS, Ctrl on Linux and Windows), so there `Ctrl+Enter` also means ⌘Enter. `Alt` is the stand-in for `⌘` (§3); `Shift`/`⌘Shift`/`Alt+Shift` + Enter are not used by the palette's text editing. Key hints show `⌘` on macOS and `Alt` on Linux and Windows (`Alt+↵`, `Alt+⇧↵`).

## 6. Rows

### 6.1 What each row does

**Run destinations** — one set of keys for every row that runs something (saved commands, command pins, `New tab`):

| Key | Destination | Menu item (shortcut shown on the right) |
| --- | --- | --- |
| `Enter` | **Choose space** when the command's *ask for space* is on (default for global commands): picker, then a new tab there. When it is off (default for space commands): same as ⌘Enter | `Run in new tab in…` `↵` (or `Run in new tab` `↵ ⌘↵` when off) |
| `⌘Enter` / `Alt+Enter` | **New tab, same space:** the current space (global command) or the command's own space (space command) | `Run in new tab` `⌘↵` |
| `Shift+Enter` | **Right pane:** splits the current tab to the right and starts it there (`terminal.open place: right`) | `Run in right pane` `⇧↵` |
| `⌘Shift+Enter` / `Alt+Shift+Enter` | **Here:** types into the current terminal (§6.2 guards busy panes) | `Run here` `⌘⇧↵` |

The Tab menu has two sections: **Run** (the four destinations, in this order; on other rows the actions that do something: Open, Switch to, Focus, Run…) and **Manage** (Ask for space, Pin/Unpin, Edit…, Remove…, Move to…, Rename, Unpin…; no shortcut). A row with nothing to manage shows one section without headers. **Ask for space** is a setting of each saved command, not of pins: *on* → Enter shows the picker, *off* → Enter runs in a new tab in the same space (the current space, or the command's own space for a space command). Default: on for global commands, off for space commands. It is changed from the command's menu (`Ask for space: on (turn off)`), and *Run in new tab in…* stays in the menu either way so a space can always be chosen. Pins have no settings: a pin behaves exactly like the command it points to. `New tab` always asks (it has no flag).

**Keys that don't work (tried in the real window on macOS):** `Ctrl+Enter` and `Opt+Enter` don't reach the palette, so *Here* is `⌘Shift+Enter`, checked before `Shift+Enter`. On Linux and Windows ⌘ is the Super / Windows key (§3), so `Alt+Enter` and `Alt+Shift+Enter` are the keys there.

**Bold** = Enter. Remove/Close items confirm first.

| Row | Options menu (`Tab` key) | Notes |
| --- | --- | --- |
| Saved command | **Run in new tab in…** (or **Run in new tab** when *ask for space* is off) · Run in new tab · Run in right pane · Run here · Ask for space: on/off · Pin/Unpin · Edit… · Remove… | The four destinations above. A new tab is not renamed (herdr-app's automatic title stays). The picker has the command's natural space first (the current space for a global command, its own space for a space command when that space is open; if it isn't open, the current space is first and the saved space is listed under Saved). If the chosen space isn't open, it's opened and its first tab is used. Right pane and Here always act on the current tab/pane (if the focus isn't on a terminal pane, herdr-app can't split it: the key does nothing); a space command's right pane checks the folder like a new tab does (`Folder not found…`); a space command's right pane starts in the command's space folder. herdr-app starts a new tab's program through the login shell but a split's program directly with the app's own `PATH`, so a command installed outside it (e.g. `pi` in `~/.local/share/pnpm/bin`) can't start in a split (`cannot start "pi": No such file or directory`); the right pane therefore always runs the command through `$SHELL -lic` |
| New tab | **In…** (choose space) · In current space · In right pane | Opens an empty tab / pane. No *Here* (nothing to type): `⌘Shift+Enter` / `Alt+Shift+Enter` is ignored |
| New space | — | Asks for a folder (prefilled with the current one), creates the space and switches to it |
| Saved space | **Open** · Open a new copy · Pin/Unpin · Add command… · Edit… · Remove… | Open switches to it if open, else creates it at its folder. Missing folder → `Folder not found: <path>` with Edit… / Remove / Back |
| Open space | **Switch to** · Close… | |
| Agent | **Focus** · Close pane… | |
| Quick action | The item's menu + Rename · Move up/down · Unpin | Identical to the item it points to, same keys, no per-pin flags (`newTab`/`chooseSpace` are gone; *ask for space* belongs to the command) |
| Host action | **Run** · Pin/Unpin | §6.4 |

Space pickers (*Run in new tab in…*, *New tab → In…*) list the current space first, then the other open spaces, then saved spaces that aren't open. Opening a saved space creates it and runs the command in its first tab.

**Running a command in a new tab or pane:** plain text (`pnpm dev -p 3001`) is started directly, split on spaces; text with shell syntax (pipes, `&&`, quotes, `$`, `~`…) runs through the user's shell (`$SHELL -ic`). Shell functions work either way; aliases only in the second form.

**Removing** a saved command or space from the palette also removes its pins (removing a space removes pins to its commands too). `⚠ missing` pins only come from hand-edits.

### 6.2 Busy pane guard

If the current pane is running an agent or another foreground process, *Here* (`⌘Shift+Enter`) asks first: **Run in new tab** · Run in right pane · Run here anyway · Cancel. Right pane, new tab and choose space never ask: they start a fresh terminal.

### 6.3 Which space you're in

The saved space whose folder contains the current pane's working folder (deepest match wins). If that folder is unknown, use the current space's folder. No match → only global commands.

### 6.4 Host actions

- **Inputs:** required inputs are asked in order: choices and yes/no → picker; pane/tab/space/plugin/agent → live picker; text/number → prompt (numbers checked as you type). Esc goes back one input. Actions whose required inputs can't be prompted for (lists, nested data) are hidden.
  - herdr-app's command list gives argument names but no types, so the kind is inferred from the name: `pane`/`tab`/`space`/`terminal` → live picker; `id` → space or tab picker by the command's group (`space.*`, `tab.*`), layout node picker for `layout.*`; `direction` → right/down (`pane.split`) or left/right/up/down; `place` → tab/right/down; `to` → program/menu; `confirmed` → yes/no; `index`/`px`/`weight` → number; `name` → layout picker (`layout.*`), theme picker (`app.theme`), else text; `layout`/`argv`/`props` → hidden; anything else → text.
  - `app.palette` is hidden. Actions ending in `.close`, `.kill`, `.reset`, `.quit` confirm first and pass `confirmed: true` when the command takes it.
- **Result:** success closes the palette and runs the action. herdr-app commands return nothing, so there is no result screen; a failure after closing shows as a toast.

### 6.5 Shared screens

- **Picker:** works like the main list, titled with a breadcrumb, e.g. `Claude → Run in new tab in`.
- **Text prompt:** one line plus a help line with an example. Invalid input shows an inline note instead of cancelling.
- **Confirm:** the title states the consequence, e.g. `Remove "web" and its 2 commands?`.
- **Status line:** a one-line notice above the footer, e.g. `✓ Added "Dev server" to web`. It clears on the next keystroke.
- **Error:** the message and what to try next.

## 7. Settings

| Row | Flow |
| --- | --- |
| `+ Add space…` | Folder (current) → label (folder name) |
| `+ Add command…` | Scope (This space / Global / other space) → command → label (the command, cut to ~30 characters) → Ask for space? (Yes / No; prefilled Yes for Global, No for a space) → Pin? (No / Yes) |
| `✎ Manage quick actions…` | Pins in order, with the quick-action menu; `+ Add quick action…` (Built-ins / Commands / Spaces / Host actions, then no further questions: a pin has no options); `↺ Reset to defaults`. A pin whose item was deleted shows here as `⚠ missing: <label>`, never in the main list |
| `✎ Manage commands…` | All commands, grouped Global / per space; the menu adds **Move to…** |
| `✎ Shortcut…` | Record a new shortcut |
| `✎ Open config file` | Opens it in `$EDITOR` in a new tab |

Settings changes refresh the list in place, show a status line and keep the palette open. Values in parentheses are prefills.

**Manage quick actions** screen:

```text
Manage quick actions

› 1  + New Claude tab          claude
  2  + New tab                 built-in
  3  + New space               built-in
  4  ▸ Run tests               here · pnpm test
     + Add quick action…
     ↺ Reset to defaults

Enter options · Shift+↑↓ move · Esc done
```

## 8. Configuration file

Recommended, and part of the install guide (README): start from `examples/atd-launcher.example.json`. Without it the palette runs on the defaults below. For hand-editing and syncing dotfiles. It lives at `~/.config/herdr-app/atd-launcher.json` (herdr-app's folder, so `$HERDR_APP_HOME/atd-launcher.json` when that is set) and is re-read every time the palette opens. Open config file creates it with the defaults if it's missing.

- **Location (decided, T5):** next to herdr-app's own hand-edited files (`keys.json`, `settings.json`), which is also where most community mods put theirs; one folder to sync. The name carries the mod's name so it can't clash with another mod's file. Not inside `mods/atd-launcher/` (saving there reloads the mod, and reinstalling or syncing the mod replaces the folder), and not in herdr-app's mod state (`localStorage` / `shared`, written by herdr-app, not for hand-editing). State the palette writes itself, like recent-use ranking, goes in `localStorage` instead.
- **Move from the old location:** the file used to be `~/.config/atd-launcher/config.json`. When the palette opens and the new file is missing but the old one exists, it copies the old file to the new place and shows the status line `✓ Config moved to ~/.config/herdr-app/atd-launcher.json; the old file is no longer read`. The old file is left alone, never read again.

```json
{
  "shortcut": "cmd-t",
  "commands": [
    { "id": "claude", "label": "Claude", "command": "claude" },
    { "id": "codex",  "label": "Codex",  "command": "codex", "askSpace": false }
  ],
  "spaces": [
    {
      "id": "web", "label": "web", "path": "~/code/web",
      "commands": [
        { "id": "dev",  "label": "Dev server", "command": "pnpm dev -p 3001" },
        { "id": "test", "label": "Run tests",  "command": "pnpm test --watch" }
      ]
    },
    { "path": "~/code/api" }
  ],
  "quickActions": [
    { "command": "claude", "label": "New Claude tab" },
    { "command": "codex", "label": "Codex in…" },
    { "builtin": "new-tab" },
    { "builtin": "new-space" },
    { "command": "web/test" },
    { "space": "api" },
    { "action": "pane.split" }
  ]
}
```

- **Defaults:** missing `shortcut` → `cmd-t` on macOS, `ctrl-t` on Linux and Windows (§3); missing `commands` → just Claude; missing `quickActions` → the three defaults; `[]` → empty. Labels (taken from the folder name or the command text) and `id`s (created by the palette) can be left out. Moving a command to another scope keeps an explicit `askSpace`; an implicit one follows the new scope's default. Commands take an optional `askSpace` (true for global commands, false for space commands when missing). Pins have no behaviour fields. Older files with `newTab` / `chooseSpace` on a pin are still read, the fields are ignored (the item's own Enter behaviour applies) and they are dropped the next time the palette rewrites that pin.
- **References:** global commands by `id`, space commands by `space-id/command-id`.
- **Errors:** a broken file shows one `⚠ Config error` row, with details and Open config file. Incomplete entries are skipped and listed there too. Everything else keeps working.
- **Preserving the file:** writes keep unknown keys and the existing order. If the file changed on disk since the palette read it, the write is refused, the file is re-read and the user is told to try again. A broken file is never written; fix it first.
- **Ids (decided):** a missing `id` defaults to a slug of the label, else of the folder's name (`~/code/api` → `api`); duplicates get `-2`, `-3`. Pinning an item writes its id into the file so the reference stays stable if the label changes.

## 9. Ideas for later

- [ ] Optional inputs for host actions ("More options…"), and list inputs (unlocks "send keys")
- [ ] Folder completion in folder prompts
- [ ] Command placeholders: `{folder}`, `{branch}`, `{file?}` asked at run time
- [ ] Keep-open mode to run several actions in a row
- [ ] Command groups: one pin opens agent + dev server + tests
- [ ] Import spaces from git repos under a root folder
- [ ] Rank recently used items higher in search (needs a local state file, kept out of the config)
- [x] Paste (⌘V) in the search box and prompts: they're herdr-app's native text field now (§5), which also makes input methods work (typing with IBus Bamboo did nothing before)
- [ ] Remote spaces (on another machine) as saved spaces; today folder checks and matching are local only


## 10. To do

Near-term work; items have IDs (T = to do, B = bug) to refer to in commits; each item gets settled here in the spec before it's built.

- [x] **T1** Hotkey to choose where a command runs: settled as the four run destinations in §6.1 (Enter choose space · ⌘ new tab · ⇧ right pane · ⌘⇧ here); built in T9. Ctrl and Opt + Enter don't work, so *here* is ⌘Shift+Enter
- [x] **T9** Build §6.1: unified run keys, shortcut column in the Tab menu, per-row footer hints, right pane (`terminal.open place: right`), remove the pin `newTab`/`chooseSpace` flags and their menu toggles (old fields ignored on read), add the per-command `askSpace` setting and its menu toggle
- [ ] **T2** Hotkey to jump to a row quickly
- [x] **T3** Hint showing what Enter will do on the selected row: the per-row footer hints in §4 cover it (built with T9)
- [x] **T4** Esc goes back to the previous screen (header now names what Esc does, and the overlay is a `window` so Esc reaches the mod; see §3, §5; tried in the real window)
- [x] **T5** Check why the config is stored at `~/.config/atd-launcher/` rather than with herdr-app's own config: no reason (left over from the old herdr TUI plugin); moved to `~/.config/herdr-app/atd-launcher.json` with a one-time copy, see §8
- [x] **T6** Rank commands above spaces in search results
- [ ] **T7** (minor) Quick actions can start Claude in a subfolder of a space: when in space `x`, run Claude in `x/sub-folder` and open it as a new Claude tab from the palette (today this is only possible with ⌘Enter)
- [x] **T8** Running a command in a new tab (including quick actions) doesn't rename the tab, so herdr-app's automatic title stays; see §6 saved command

### Bugs

- [ ] **B1** The "New Claude tab" quick action doesn't show up in search results
- [x] **B2** Search results make it hard to tell agents, commands and other kinds of rows apart, because the ranking reorders them and mixes the kinds together: settled as a color type icon per kind while searching (§4.3)
- [ ] **B3** Consider listing tabs that aren't running an agent too
- [ ] **B4** New space with a path taken from the current space (`~/current-space`), then the path changed (`~/new-space`): opening a new tab in that space goes to `~/current-space`. A new tab should open in the space's changed path

// Command Palette (docs/BEHAVIOR-SPEC-v2.md). Opened with `mod.open:atd-launcher`
// (⌘T on macOS, Ctrl+T elsewhere); pressing it again closes it. One list of every target and action.
//
// Screens form a stack. The main list is the bottom; options menus, pickers,
// prompts and confirms are pushed on top and resolve a promise, so flows are
// plain async functions (`await this.pick(...)`). Esc pops one step.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import {
  spaces, agents, panes, focused, commands, terminals, theme, props, closeOverlay, run, hc, exec,
  home, appHome, readTextFile, writeTextFile, layout, layouts, themes, notify, settings, window as appWindow,
} from "herdr";
import * as C from "./lib/config.js";
import { buildMain, flatten, typeIcon, currentSavedSpace, openSpaceFor, expand, tilde, commandRow, savedSpaceRow, openSpaceRow, hostRow, pinRow, resolvePin } from "./lib/model.js";
import { hostActions, checkNumber } from "./lib/hostactions.js";
import { defaultShortcut, runKeyHints, runMode, shortcutExample, unreachableShortcut } from "./lib/keys.js";

const MOD = "atd-launcher";
const BACK = Symbol("back");
const ROW_H = 30;
const HEAD_H = 26;

export default class Palette extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle(); // the palette's own keyboard: the record screen has no text field
    // Text fields are herdr-app's native ones, so input methods (IBus…), selection and paste work.
    // One per placeholder: the main search, other lists' search, prompts.
    this.fields = {
      main: InputState.new({ placeholder: "Search everything…" }),
      list: InputState.new({ placeholder: "Search…" }),
      prompt: InputState.new({}),
    };
    for (const st of Object.values(this.fields)) {
      st.on("change", (_e, cx) => this.onTextChange(st, cx));
      st.on("submit", (e, cx) => this.enter(runMode({ platform: e.secondary, shift: e.shift }), cx));
    }
    // The window overlay moves focus on Tab before on_key_down sees it, so bind Tab to an action.
    try { cx.bind_keys([{ keystroke: "tab", action: "atd-tab", context: "AtdPalette" }]); } catch (e) { /* keep going: other keys still work */ }
    this.scroll = VirtualListScrollHandle.new();
    this.home = home();
    this.platform = appWindow()?.platform ?? "linux";
    this.runKeys = runKeyHints(this.platform);
    this.configDir = appHome();
    this.configPath = `${this.configDir}/atd-launcher.json`;
    this.oldConfigPath = `${this.home}/.config/atd-launcher/config.json`; // before T5 (§8)
    this.cfg = null; // null until read: config sections show Loading…
    this.cfgText = null;
    this.status = null;
    this.shell = "/bin/zsh";
    this.closed = false;
    const f = focused();
    this.origin = { space: f?.space ?? null, tab: f?.tab ?? null, pane: f?.pane ?? null, terminal: f?.terminal ?? null, cwd: f?.cwd ?? null };
    this.host = hostActions(commands());
    this.stack = [this.mainScreen()];
    this.syncField();
    cx.timer.after(300, () => this.syncField());
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", 'printf %s "$SHELL"']);
        if (r.code === 0 && r.stdout.trim()) this.shell = r.stdout.trim();
      } catch {}
      await this.moveOldConfig().catch(() => {});
      await this.loadConfig();
      await this.syncShortcut().catch(() => {});
      cx.notify();
    });
  }

  // ---- config I/O --------------------------------------------------------------

  // §8: copy the pre-T5 file to the new place once; the old file is left alone.
  async moveOldConfig() {
    if ((await readTextFile(this.configPath).catch(() => null)) != null) return;
    const old = await readTextFile(this.oldConfigPath).catch(() => null);
    if (old == null) return;
    await writeTextFile(this.configPath, old, null);
    this.setStatus(`✓ Config moved to ${tilde(this.configPath, this.home)}; the old file is no longer read`);
  }

  async loadConfig() {
    let text = null;
    try { text = await readTextFile(this.configPath); } catch (e) { text = null; }
    this.cfgText = text;
    this.cfg = C.parseConfig(text, this.platform);
  }

  /** Applies `edit(raw)` to the file and saves it. Returns edit's result. */
  async save(edit) {
    const onDisk = await readTextFile(this.configPath).catch(() => null);
    if (onDisk !== this.cfgText) {
      await this.loadConfig();
      throw new Error("The config file changed on disk; it has been reloaded. Try again.");
    }
    if (this.cfg.fatal) throw new Error(`Fix the config file first: ${this.cfg.fatal}`);
    const raw = onDisk && onDisk.trim() ? JSON.parse(onDisk) : {};
    const out = edit(raw);
    const text = C.serialize(raw);
    await writeTextFile(this.configPath, text, onDisk);
    this.cfgText = text;
    this.cfg = C.parseConfig(text, this.platform);
    return out;
  }

  // ---- live context ---------------------------------------------------------------

  originPane() {
    return this.origin.pane ? panes().find((p) => p.pane === this.origin.pane) ?? null : null;
  }
  originCwd() {
    return this.originPane()?.cwd ?? this.origin.cwd ?? null;
  }
  currentSpace() {
    return spaces().find((s) => s.id === this.origin.space) ?? null;
  }
  currentSaved() {
    if (!this.cfg) return null;
    return currentSavedSpace(this.cfg, this.originCwd(), this.currentSpace()?.folder, this.home);
  }
  snap() {
    return { spaces: spaces(), agents: agents(), focused: { ...this.origin }, home: this.home };
  }
  ctx() {
    return { hostActions: this.host, currentSaved: this.currentSaved() };
  }

  // ---- screens ----------------------------------------------------------------------

  mainScreen() {
    return {
      type: "list", main: true, title: "Command Palette", query: "", sel: 0, selKey: null, counter: true,
      build: () => buildMain(this.snap(), this.cfg, this.ctx()),
      footer: (row) => this.mainFooter(row),
      onEnter: (row, cx, mode) => this.enterRow(row, cx, mode),
      onTab: (row, cx) => this.openMenu(row, cx),
    };
  }

  top() { return this.stack[this.stack.length - 1]; }

  push(cx, screen) {
    this.stack.push({ query: "", sel: 0, selKey: null, ...screen });
    this.syncField();
    this.scroll.scroll_to_item(0);
    cx.notify();
  }

  /** Pushes a screen and waits for it to resolve (null on Esc). */
  ask(cx, screen) {
    return new Promise((resolve) => {
      this.push(cx, { ...screen, resolve });
    }).then((v) => { cx.notify(); return v; });
  }

  finish(screen, value) {
    const i = this.stack.indexOf(screen);
    if (i > 0) this.stack.splice(i, 1);
    this.syncField();
    screen.resolve?.(value);
  }

  // ---- text fields --------------------------------------------------------------

  fieldFor(s) {
    return s.type === "prompt" ? this.fields.prompt : s.main ? this.fields.main : this.fields.list;
  }

  /** Puts the top screen's text in its field and the keyboard on it. Call after the stack changes. */
  syncField() {
    if (this.closed) return;
    const s = this.top();
    if (s.type === "record") return this.handle.focus();
    const st = this.fieldFor(s);
    const text = s.type === "prompt" ? s.value : s.query;
    if (st.value() !== text) st.set_value(text);
    st.focus();
  }

  /** Sets the top screen's text from code (Esc, Ctrl+U), field included. */
  setText(s, text) {
    if (s.type === "prompt") { s.value = text; s.note = s.check ? s.check(text) : null; }
    else { s.query = text; s.sel = 0; s.selKey = null; this.scroll.scroll_to_item(0); }
    const st = this.fieldFor(s);
    if (st.value() !== text) st.set_value(text);
  }

  onTextChange(st, cx) {
    const s = this.top();
    if (s.type === "record" || this.fieldFor(s) !== st) return;
    const text = st.value();
    if (text === (s.type === "prompt" ? s.value : s.query)) return;
    this.status = null;
    this.setText(s, text);
    cx.notify();
  }

  // Every way out: Esc, Ctrl+C, actions, and herdr-app's teardown hook `close(cx)`
  // (the shortcut pressed again). §3: the keyboard goes back to the pane the
  // palette was opened from; an action's own run() after this moves it on.
  close() {
    if (this.closed) return;
    this.closed = true;
    this.refocus();
    closeOverlay(props().overlay);
  }

  refocus() {
    const { pane, terminal } = this.origin;
    if (pane && panes().some((p) => p.pane === pane)) run("pane.focus", { pane });
    else if (terminal) run("pane.focus", { terminal });
  }

  back(cx) {
    const s = this.top();
    if (s.type === "list" && s.query) {
      this.setText(s, "");
    } else if (this.stack.length > 1) {
      if (s.resolve) this.finish(s, null);
      else { this.stack.pop(); this.syncField(); }
      this.scrollToSel();
    } else {
      this.close();
    }
    cx.notify();
  }

  /** What Esc will do now, mirroring back(). */
  escHint() {
    const s = this.top();
    if (s.type === "list" && s.query) return "Esc clear search";
    if (this.stack.length > 1) return `Esc back to ${this.stack[this.stack.length - 2].title}`;
    return "Esc close";
  }

  setStatus(text, kind = "ok") { this.status = { text, kind }; }

  /** Runs an async flow; failures show an error screen, then the user is back. */
  flow(cx, fn) {
    cx.spawn(async (cx) => {
      try {
        await fn(cx);
      } catch (e) {
        if (!this.closed && !e?.quiet) await this.showError(cx, e);
      }
      if (!this.closed) cx.notify();
    });
  }

  async showError(cx, e, hint) {
    const msg = String(e?.message ?? e);
    await this.ask(cx, {
      type: "list", title: "Error", message: msg, messageKind: "error", hint: hint ?? e?.hint ?? "Press Enter or Esc to go back.",
      build: () => [{ rows: [{ key: "back", icon: "", label: "Back" }] }],
      onEnter: (_row, _cx) => this.finish(this.top(), true),
    });
  }

  /** Multi-step input: each step returns BACK to go to the previous one. */
  async steps(cx, fns) {
    const st = {};
    let i = 0;
    while (i < fns.length) {
      if (i < 0) return null;
      let r;
      try {
        r = await fns[i](st);
      } catch (e) {
        if (e?.quiet || this.closed) return null;
        // Back to the same input, with what was typed kept.
        await this.showError(cx, e);
        continue;
      }
      if (this.closed) return null;
      i += r === BACK ? -1 : 1;
      if (i < 0) return null;
    }
    return st;
  }

  // ---- generic screens --------------------------------------------------------------

  /** A picker: rows [{key,label,detail,icon,color,value}] or sections. Resolves the row or null. */
  pick(cx, title, rowsOrSections, extra = {}) {
    const sections = Array.isArray(rowsOrSections) && rowsOrSections.length && rowsOrSections[0].rows
      ? rowsOrSections : [{ rows: rowsOrSections }];
    return this.ask(cx, {
      type: "list", title, footer: "Enter choose · Esc back", ...extra,
      build: typeof extra.build === "function" ? extra.build : () => sections,
      onEnter: (row) => this.finish(this.top(), row),
    });
  }

  async confirm(cx, title, detail) {
    const r = await this.pick(cx, title, [
      { key: "no", icon: "", label: "No", value: false },
      { key: "yes", icon: "−", color: "danger", label: "Yes", value: true },
    ], { message: detail, footer: "Enter choose · Esc no" });
    return r?.value === true;
  }

  /** A one-line text prompt. Resolves the text or null. */
  prompt(cx, title, { value = "", help = "", check = null } = {}) {
    return this.ask(cx, { type: "prompt", title, value, help, check, note: null, footer: "Enter OK · Esc back" });
  }

  // ---- key handling -------------------------------------------------------------

  // Keys the text field doesn't take. Stop propagation only for keys used here:
  // anything else (letters, Backspace, ←/→…) belongs to the field.
  onKey(e, cx) {
    const s = this.top();
    const m = e.modifiers ?? {};
    const k = e.key;
    if (k === "c" && m.control) { cx.stop_propagation(); return this.close(); }

    if (s.type === "record") {
      cx.stop_propagation();
      if (k === "escape") return this.back(cx);
      if (["shift", "control", "alt", "platform", "function", "cmd", "ctrl"].includes(k)) return;
      this.finish(s, e.keystroke);
      return cx.notify();
    }
    if (k === "escape") { cx.stop_propagation(); this.status = null; return this.back(cx); }
    // Plain Enter normally arrives as the field's submit; Alt+Enter and friends may come here.
    if (k === "enter") { cx.stop_propagation(); return this.enter(runMode(m), cx); }
    if (k === "u" && m.control) { cx.stop_propagation(); this.status = null; this.setText(s, ""); return cx.notify(); }
    if (s.type !== "list") return;

    const { rows } = this.view(s);
    const n = rows.length;
    const move = (d) => {
      if (!n) return;
      s.sel = Math.abs(d) === 1 ? (s.sel + d + n) % n : Math.max(0, Math.min(n - 1, s.sel + d));
      s.selKey = rows[s.sel]?.key ?? null;
      this.scrollToSel(d);
    };
    const row = rows[s.sel];
    if ((k === "up" || k === "down") && m.shift && s.onMove) { if (row) s.onMove(row, k === "up" ? -1 : 1, cx); }
    else if (k === "up" || (m.control && k === "p")) move(-1);
    else if (k === "down" || (m.control && k === "n")) move(1);
    else if (k === "pageup") move(-10);
    else if (k === "pagedown") move(10);
    else if (k === "tab") { if (row && s.onTab) s.onTab(row, cx); }
    else return;
    cx.stop_propagation();
    this.status = null;
    cx.notify();
  }

  /** Enter with a run mode (§6.1), from the field's submit or from onKey. */
  enter(mode, cx) {
    // One press can reach both the field's submit and on_key_down; act on it once.
    const now = Date.now();
    if (now - (this.lastEnter ?? 0) < 80) return;
    this.lastEnter = now;
    const s = this.top();
    this.status = null;
    if (s.type === "prompt") {
      const note = s.check ? s.check(s.value) : null;
      if (note) s.note = note;
      else this.finish(s, s.value);
    } else if (s.type === "list") {
      const row = this.view(s).rows[s.sel];
      if (row) s.onEnter?.(row, cx, mode);
    }
    cx.notify();
  }

  /** The list a screen shows now: items (with headers) and selectable rows. */
  view(s) {
    const v = flatten(s.build(), s.query);
    if (s.selKey) {
      const i = v.rows.findIndex((r) => r.key === s.selKey);
      if (i >= 0) s.sel = i;
    }
    if (s.sel >= v.rows.length) s.sel = Math.max(0, v.rows.length - 1);
    return v;
  }

  // §4.2: keep the selected row on screen. `dir` is the last move: moving down
  // scrolls to the row itself, otherwise its section header comes along.
  scrollToSel(dir = 0) {
    const s = this.top();
    if (s.type !== "list") return;
    const { items, rows } = this.view(s);
    const key = rows[s.sel]?.key;
    if (key == null) return;
    let i = items.findIndex((it) => it.row?.key === key);
    if (i > 0 && dir <= 0 && items[i - 1].head) i -= 1;
    if (i >= 0) this.scroll.scroll_to_item(i);
  }

  // ---- rows: default action and options menu ---------------------------------

  // §6.1: Enter runs the first item; ⌘/Alt, Shift and Ctrl run the item with that
  // slot. On rows that run things, a key without an item is ignored; on the others
  // the modifiers do the same as Enter.
  enterRow(row, cx, mode = "enter") {
    const items = this.menuFor(row);
    if (!items.length) return;
    let item = items[0];
    if (mode !== "enter") {
      const hit = items.find((x) => x.slot === mode);
      const runnable = items.some((x) => x.slot === "pane");
      if (hit) item = hit;
      else if (runnable) return;
    }
    this.flow(cx, (cx) => this.runItem(item, cx));
  }

  /** Footer of the main list: the keys that do something on the selected row. */
  mainFooter(row) {
    const items = row ? this.menuFor(row) : [];
    const keys = this.runKeys;
    const parts = [];
    if (items[0]) parts.push(`Enter ${items[0].short ?? items[0].label.toLowerCase()}`);
    for (const it of items.slice(1)) if (keys[it.slot] && it.short) parts.push(`${keys[it.slot]} ${it.short}`);
    if (items[0]) parts.push("Tab more");
    return parts.join(" · ");
  }

  async runItem(item, cx) {
    const did = await item.act(cx);
    if (did && typeof did === "string") this.setStatus(did);
  }

  openMenu(row, cx, items = this.menuFor(row)) {
    if (!items.length) return;
    const screen = {
      type: "list", title: `${row.label} → Options`, footer: "Enter choose · Esc back",
      build: () => {
        const rows = items.map((it, i) => ({
          key: `m${i}`, icon: it.icon ?? "", color: it.color ?? null, label: it.label, detail: it.detail ?? "", item: it,
          aside: [i === 0 ? "↵" : "", this.runKeys[it.slot] ?? ""].filter(Boolean).join(" "),
          run: i === 0 || Boolean(it.slot || it.short),
        }));
        const run = rows.filter((r) => r.run);
        const manage = rows.filter((r) => !r.run);
        return manage.length ? [{ title: "Run", rows: run }, { title: "Manage", rows: manage }] : [{ rows: run }];
      },
      onEnter: (r, cx) => this.flow(cx, async (cx) => {
        const did = await r.item.act(cx);
        if (did && !this.closed) {
          // A settings change: back to the list below, with a status line.
          const i = this.stack.indexOf(screen);
          if (i > 0) { this.stack.splice(i, 1); this.syncField(); }
          if (typeof did === "string") this.setStatus(did);
        }
      }),
    };
    this.push(cx, screen);
  }

  menuFor(row) {
    switch (row.kind) {
      case "command": return this.commandMenu(row.command);
      case "savedSpace": return this.savedSpaceMenu(row.saved);
      case "openSpace": return this.openSpaceMenu(row.space);
      case "agent": return this.agentMenu(row.agent);
      case "pin": return this.pinMenu(row);
      case "host": return this.hostMenu(row.host);
      case "builtin": return this.builtinMenu(row.ref);
      case "setting": return [{ label: row.label, act: (cx) => this.setting(row.setting, cx) }];
      case "configError": return [{ label: "Show details", act: (cx) => this.showConfigErrors(cx) }];
      default: return [];
    }
  }

  pinToggle(kind, ref, label) {
    const pinned = this.cfg && C.pinFor(this.cfg, kind, ref);
    return pinned
      ? { label: "Unpin", icon: "−", act: async () => { await this.save((raw) => C.unpinItem(raw, kind, ref)); return `✓ Unpinned "${label}"`; } }
      : { label: "Pin", icon: "+", act: async () => { await this.save((raw) => C.addPin(raw, { [kind]: ref })); return `✓ Pinned "${label}"`; } };
  }

  commandMenu(c, extra = []) {
    const choose = { label: "Run in new tab in…", icon: "+", color: "create", slot: "choose", short: "choose space", act: async (cx) => {
      const dest = await this.pickSpace(cx, `${c.label} → Run in new tab in`, c);
      if (dest) return this.runNewTab(cx, c, dest);
    } };
    const tab = { label: "Run in new tab", icon: "+", color: "create", slot: "tab", short: "new tab", act: (cx) => this.runNewTab(cx, c) };
    const pane = { label: "Run in right pane", icon: "+", color: "create", slot: "pane", short: "right pane", act: (cx) => this.runPane(cx, c) };
    const here = { label: "Run here", icon: "▸", slot: "here", short: "here", act: (cx) => this.runHere(cx, c) };
    return [
      ...(c.askSpace ? [choose, tab] : [tab, choose]), pane, here,
      { label: c.askSpace ? "Ask for space: on (turn off)" : "Ask for space: off (turn on)", icon: "✎", act: async () => {
        await this.save((raw) => C.updateCommand(raw, c.ref, { askSpace: !c.askSpace }));
        return `✓ "${c.label}" now ${c.askSpace ? "opens a new tab in the same space" : "asks for a space"}`;
      } },
      this.pinToggle("command", c.ref, c.label),
      ...extra,
      { label: "Edit…", icon: "✎", act: (cx) => this.editCommand(cx, c) },
      { label: "Remove…", icon: "−", color: "danger", act: async (cx) => {
        if (!(await this.confirm(cx, `Remove "${c.label}"?`))) return;
        await this.save((raw) => C.removeCommand(raw, c.ref));
        return `✓ Removed "${c.label}"`;
      } },
    ];
  }

  savedSpaceMenu(s) {
    const n = s.commands.length;
    return [
      { label: "Open", icon: "→", short: "open", act: (cx) => this.openSaved(cx, s, false) },
      { label: "Open a new copy", icon: "+", color: "create", slot: "tab", short: "new copy", act: (cx) => this.openSaved(cx, s, true) },
      this.pinToggle("space", s.id, s.label),
      { label: "Add command…", icon: "+", color: "create", act: (cx) => this.addCommandFlow(cx, s.id) },
      { label: "Edit…", icon: "✎", act: (cx) => this.editSpace(cx, s) },
      { label: "Remove…", icon: "−", color: "danger", act: async (cx) => {
        const title = n ? `Remove "${s.label}" and its ${n} command${n > 1 ? "s" : ""}?` : `Remove "${s.label}"?`;
        if (!(await this.confirm(cx, title, "The folder and any open space are left alone."))) return;
        await this.save((raw) => C.removeSpace(raw, s.id));
        return `✓ Removed "${s.label}"`;
      } },
    ];
  }

  openSpaceMenu(sp) {
    return [
      { label: "Switch to", icon: "→", act: () => { this.close(); run("space.select", { id: sp.id }); } },
      { label: "Close…", icon: "−", color: "danger", act: async (cx) => {
        if (!(await this.confirm(cx, `Close space "${sp.name}" and end its terminals?`))) return;
        this.close();
        run("space.close", { id: sp.id, confirmed: true });
      } },
    ];
  }

  agentMenu(a) {
    return [
      { label: "Focus", icon: "→", act: () => { this.close(); run("agent.focus", { terminal: a.address }); } },
      { label: "Close pane…", icon: "−", color: "danger", act: async (cx) => {
        if (!(await this.confirm(cx, `Close ${a.program?.name ?? "the agent"}'s pane in "${a.space_name}"?`, a.title))) return;
        this.close();
        run("pane.close", { pane: a.pane });
      } },
    ];
  }

  builtinMenu(ref) {
    if (ref === "new-tab") {
      return [
        { label: "In…", icon: "+", color: "create", slot: "choose", short: "choose space", act: async (cx) => {
          const dest = await this.pickSpace(cx, "New tab → In");
          if (dest) return this.newTabIn(dest, {});
        } },
        { label: "In current space", icon: "+", color: "create", slot: "tab", short: "new tab", act: () => { this.close(); run("tab.new", this.origin.space ? { space: this.origin.space } : {}); } },
        { label: "In right pane", icon: "+", color: "create", slot: "pane", short: "right pane", act: () => { this.close(); run("terminal.open", { place: "right" }); } },
      ];
    }
    if (ref === "new-space") return [{ label: "New space", icon: "+", color: "create", act: (cx) => this.newSpaceFlow(cx) }];
    return [];
  }

  hostMenu(h) {
    return [
      { label: "Run", icon: "▸", act: (cx) => this.runHost(cx, h) },
      this.pinToggle("action", h.name, h.title),
    ];
  }

  pinMenu(row) {
    const pin = row.pin;
    const t = row.target;
    let base = [];
    if (t?.kind === "command") base = this.commandMenu(t.command).filter((x) => x.label !== "Pin" && x.label !== "Unpin");
    else if (t?.kind === "space") base = this.savedSpaceMenu(t.saved).filter((x) => x.label !== "Pin" && x.label !== "Unpin");
    else if (t?.kind === "host") base = this.hostMenu(t.host).slice(0, 1);
    else if (t?.kind === "builtin") base = this.builtinMenu(t.ref);
    const name = row.label;
    const q = [
      { label: "Rename…", icon: "✎", act: async (cx) => {
        const v = await this.prompt(cx, `${name} → Rename`, { value: pin.label ?? "", help: "Empty: use the item's own label" });
        if (v == null) return;
        await this.save((raw) => C.renamePin(raw, pin.index, v.trim()));
        return `✓ Renamed quick action`;
      } },
    ];
    q.push(
      { label: "Move up", icon: "↑", act: async () => { await this.save((raw) => C.movePin(raw, pin.index, -1)); return `✓ Moved "${name}" up`; } },
      { label: "Move down", icon: "↓", act: async () => { await this.save((raw) => C.movePin(raw, pin.index, 1)); return `✓ Moved "${name}" down`; } },
      { label: "Unpin", icon: "−", color: "danger", act: async () => { await this.save((raw) => C.removePin(raw, pin.index)); return `✓ Unpinned "${name}"`; } },
    );
    return [...base, ...q];
  }

  // ---- actions ------------------------------------------------------------------

  toArgv(command) {
    const cmd = command.trim();
    if (/[|&;<>()$`\\"'*?[\]#~{}=!\n]/.test(cmd)) return [this.shell, "-ic", cmd];
    return cmd.split(/\s+/);
  }

  async runHere(cx, c) {
    const term = this.origin.terminal;
    const pane = this.originPane();
    const busy = !term || !pane || !pane.program?.shell || pane.status != null;
    let force = false;
    if (busy) {
      const opts = [
        { key: "new", icon: "+", color: "create", label: "Run in new tab", value: "new" },
        { key: "pane", icon: "+", color: "create", label: "Run in right pane", value: "pane" },
      ];
      if (term) opts.push({ key: "here", icon: "▸", label: "Run here anyway", value: "here" });
      opts.push({ key: "cancel", icon: "", label: "Cancel", value: null });
      const what = term ? `The current pane is running ${pane?.program?.name ?? "something"}` : "There's no terminal here";
      const r = await this.pick(cx, `${c.label} → Run here`, opts, { message: `${what}. Run "${c.command}" anyway?` });
      if (!r?.value) return;
      if (r.value === "new") return this.runNewTab(cx, c);
      if (r.value === "pane") return this.runPane(cx, c);
      force = true;
    }
    const args = ["send", ...(force ? ["--force"] : []), term, c.command];
    const r = await hc(args);
    if (r.code !== 0) {
      let msg = r.stderr.trim() || r.stdout.trim() || `hc send failed (${r.code})`;
      try { msg = JSON.parse(msg).error?.message ?? msg; } catch {}
      throw Object.assign(new Error(msg), { hint: "Try Run in new tab instead." });
    }
    this.close();
  }

  /** §6.1 right pane: splits the current tab; a space command starts in its space's folder. */
  async runPane(cx, c) {
    const saved = c.space ? C.findSpace(this.cfg, c.space) : null;
    const folder = saved ? expand(saved.path, this.home) : null;
    if (saved) await this.checkFolder(cx, saved);
    this.close();
    // herdr-app starts a split's program directly with its own PATH (tab.new goes through the
    // login shell), so `pi` from ~/.local/share/pnpm/bin isn't found. Use the login shell here too.
    run("terminal.open", { argv: [this.shell, "-lic", c.command.trim()], place: "right", ...(folder ? { folder } : {}) });
  }

  /** dest: { open: SpaceInfo } | { saved: savedSpace } | undefined (the command's own place). */
  async runNewTab(cx, c, dest) {
    const argv = this.toArgv(c.command);
    if (!dest) {
      if (c.space) {
        const saved = C.findSpace(this.cfg, c.space);
        const open = saved && openSpaceFor(saved, spaces(), this.home);
        dest = open ? { open, folder: expand(saved.path, this.home) } : saved ? { saved } : null;
      }
      if (!dest) dest = { current: true };
    }
    if (dest.saved && !dest.open) await this.checkFolder(cx, dest.saved);
    return this.newTabIn(dest, { argv });
  }

  newTabIn(dest, extra) {
    if (dest.current) {
      this.close();
      run("tab.new", { ...(this.origin.space ? { space: this.origin.space } : {}), ...extra });
    } else if (dest.open) {
      const folder = dest.folder ?? (dest.open.folder || undefined);
      this.close();
      run("tab.new", { space: dest.open.id, ...(folder ? { folder } : {}), ...extra });
      run("space.select", { id: dest.open.id });
    } else if (dest.saved) {
      this.close();
      run("space.new", { name: dest.saved.label, folder: expand(dest.saved.path, this.home), ...(extra.argv ? { argv: extra.argv } : {}) });
    }
  }

  async folderExists(path) {
    try {
      return (await exec("test", ["-d", expand(path, this.home)])).code === 0;
    } catch {
      return false;
    }
  }

  // Throws a handled error with Edit / Remove / Back when the folder is gone.
  async checkFolder(cx, s) {
    if (await this.folderExists(s.path)) return;
    const r = await this.pick(cx, `Folder not found: ${s.path}`, [
      { key: "edit", icon: "✎", label: "Edit…", value: "edit" },
      { key: "remove", icon: "−", color: "danger", label: "Remove", value: "remove" },
      { key: "back", icon: "", label: "Back", value: null },
    ], { message: `"${s.label}" points at a folder that doesn't exist.`, messageKind: "error" });
    if (r?.value === "edit") await this.editSpace(cx, s);
    if (r?.value === "remove") {
      if (await this.confirm(cx, `Remove "${s.label}"?`)) {
        await this.save((raw) => C.removeSpace(raw, s.id));
        this.setStatus(`✓ Removed "${s.label}"`);
      }
    }
    throw Object.assign(new Error("cancelled"), { quiet: true });
  }

  async openSaved(cx, s, copy) {
    const open = openSpaceFor(s, spaces(), this.home);
    if (open && !copy) {
      this.close();
      run("space.select", { id: open.id });
      return;
    }
    try {
      await this.checkFolder(cx, s);
    } catch (e) {
      if (e.quiet) return;
      throw e;
    }
    this.close();
    run("space.new", { name: s.label, folder: expand(s.path, this.home) });
  }

  /** "Another space…": open spaces (current first), then saved spaces that aren't open. */
  async pickSpace(cx, title, c) {
    const snap = this.snap();
    const open = snap.spaces.map((sp) => ({ ...openSpaceRow(sp, snap), value: { open: sp } }));
    // The command's natural space first: its own space, else the current one (§6.1).
    const own = c?.space ? C.findSpace(this.cfg, c.space) : null;
    const ownOpen = own && openSpaceFor(own, snap.spaces, this.home);
    const rank = (r) => (ownOpen ? (r.value.open.id === ownOpen.id ? 1 : 0) : r.current ? 1 : 0);
    open.sort((a, b) => rank(b) - rank(a));
    const saved = (this.cfg?.spaces ?? []).filter((s) => !openSpaceFor(s, snap.spaces, this.home))
      .map((s) => ({ ...savedSpaceRow(s, snap), value: { saved: s } }));
    const r = await this.pick(cx, title, [{ title: "Open", rows: open }, { title: "Saved", rows: saved }].filter((x) => x.rows.length));
    if (!r) return null;
    if (r.value.saved) {
      try { await this.checkFolder(cx, r.value.saved); } catch (e) { if (e.quiet) return null; throw e; }
    }
    return r.value;
  }

  async newSpaceFlow(cx) {
    await this.steps(cx, [
      async (s) => {
        const v = await this.prompt(cx, "New space → Folder", {
          value: s.path ?? tilde(this.originCwd() ?? this.home, this.home), help: "e.g. ~/code/web",
        });
        if (v == null) return BACK;
        s.path = v.trim();
        if (!(await this.folderExists(s.path))) throw Object.assign(new Error(`Folder not found: ${s.path}`), { hint: "Check the path and try again." });
        this.close();
        run("space.new", { folder: expand(s.path, this.home) });
      },
    ]);
  }

  // ---- host actions -------------------------------------------------------------

  async runHost(cx, h) {
    const args = {};
    const st = await this.steps(cx, h.inputs.map((inp) => async () => {
      const v = await this.askInput(cx, h, inp);
      if (v == null) return BACK;
      args[inp.name] = v;
    }));
    if (!st) return;
    if (h.destructive && !(await this.confirm(cx, `${h.title}?`, h.about))) return;
    if (h.takesConfirmed) args.confirmed = true;
    this.close();
    try {
      run(h.name, args);
    } catch (e) {
      notify({ title: h.title, body: String(e?.message ?? e), level: "error" });
    }
  }

  async askInput(cx, h, inp) {
    const title = `${h.title} → ${inp.name}`;
    const snap = this.snap();
    const val = (rows) => this.pick(cx, title, rows).then((r) => (r ? r.value : null));
    switch (inp.kind) {
      case "choice": return val(inp.choices.map((c) => ({ key: c, icon: "", label: c, value: c })));
      case "bool": return val([{ key: "no", icon: "", label: "No", value: false }, { key: "yes", icon: "", label: "Yes", value: true }]).then((v) => v);
      case "space": return val(snap.spaces.map((sp) => ({ ...openSpaceRow(sp, snap), value: sp.id })));
      case "tab": return val(snap.spaces.flatMap((sp) => sp.tabs.map((t) => ({
        key: t.id, icon: sp.id === this.origin.space && t.id === this.origin.tab ? "●" : "→", label: `${sp.name} › ${t.name}`, detail: t.status ?? "", value: t.id,
      }))));
      case "pane": {
        const tabName = new Map(snap.spaces.flatMap((sp) => sp.tabs.map((t) => [t.id, `${sp.name} › ${t.name}`])));
        return val(panes().map((p) => ({ key: p.pane, icon: p.pane === this.origin.pane ? "●" : "→", label: p.title || p.program?.name || p.pane, detail: tabName.get(p.tab) ?? "", extras: [p.cwd ?? ""], value: p.pane })));
      }
      case "terminal": return val(terminals().filter((t) => t.state === "live").map((t) => ({
        key: t.address, icon: t.address === this.origin.terminal ? "●" : "→", label: t.name || t.address, detail: (t.argv ?? []).join(" "), value: t.address,
      })));
      case "layoutNode": {
        const ids = [];
        const walk = (n) => { if (!n || typeof n !== "object") return; if (n.id) ids.push(n.id); (n.children ?? []).forEach(walk); (n.floating ?? []).forEach(walk); };
        walk(layout());
        return val(ids.map((id) => ({ key: id, icon: "", label: id, value: id })));
      }
      case "layoutName": return val(layouts().map((n) => ({ key: n, icon: "", label: n, value: n })));
      case "theme": return val(themes().map((t) => ({ key: t.name, icon: "", label: t.name, detail: t.light ? "light" : "dark", value: t.name })));
      case "number": {
        const v = await this.prompt(cx, title, { help: "A number, e.g. 1", check: checkNumber });
        return v == null ? null : Number(v);
      }
      default: {
        const v = await this.prompt(cx, title, { help: h.about });
        return v == null ? null : v;
      }
    }
  }

  // ---- editing ------------------------------------------------------------------

  async editCommand(cx, c) {
    const st = await this.steps(cx, [
      async (s) => {
        const v = await this.prompt(cx, `${c.label} → Command`, { value: s.command ?? c.command, help: "e.g. pnpm dev -p 3001", check: (x) => (x.trim() ? null : "Enter a command") });
        if (v == null) return BACK;
        s.command = v.trim();
      },
      async (s) => {
        const v = await this.prompt(cx, `${c.label} → Label`, { value: s.label ?? c.label, help: "Shown in the list", check: (x) => (x.trim() ? null : "Enter a label") });
        if (v == null) return BACK;
        s.label = v.trim();
        await this.save((raw) => C.updateCommand(raw, c.ref, { label: s.label, command: s.command }));
      },
    ]);
    return st ? `✓ Saved "${st.label}"` : null;
  }

  async editSpace(cx, sp) {
    const st = await this.steps(cx, [
      async (s) => {
        const v = await this.prompt(cx, `${sp.label} → Folder`, { value: s.path ?? sp.path, help: "e.g. ~/code/web" });
        if (v == null) return BACK;
        s.path = v.trim();
        if (!(await this.folderExists(s.path))) throw Object.assign(new Error(`Folder not found: ${s.path}`), { hint: "Check the path and try again." });
      },
      async (s) => {
        const v = await this.prompt(cx, `${sp.label} → Label`, { value: s.label ?? sp.label, check: (x) => (x.trim() ? null : "Enter a label") });
        if (v == null) return BACK;
        s.label = v.trim();
        await this.save((raw) => C.updateSpace(raw, sp.id, { label: s.label, path: s.path }));
      },
    ]);
    return st ? `✓ Saved "${st.label}"` : null;
  }

  async addSpaceFlow(cx) {
    const st = await this.steps(cx, [
      async (s) => {
        const v = await this.prompt(cx, "Add space → Folder", { value: s.path ?? tilde(this.originCwd() ?? this.home, this.home), help: "e.g. ~/code/web" });
        if (v == null) return BACK;
        s.path = v.trim();
        if (!(await this.folderExists(s.path))) throw Object.assign(new Error(`Folder not found: ${s.path}`), { hint: "Check the path and try again." });
      },
      async (s) => {
        const v = await this.prompt(cx, "Add space → Label", { value: s.label ?? C.basename(expand(s.path, this.home)), check: (x) => (x.trim() ? null : "Enter a label") });
        if (v == null) return BACK;
        s.label = v.trim();
        await this.save((raw) => C.addSpace(raw, { label: s.label, path: s.path }));
      },
    ]);
    return st ? `✓ Added space "${st.label}"` : null;
  }

  async addCommandFlow(cx, fixedSpace) {
    const here = this.currentSaved();
    const st = await this.steps(cx, [
      async (s) => {
        if (fixedSpace !== undefined) { s.space = fixedSpace; return; }
        const rows = [];
        if (here) rows.push({ key: "here", icon: "●", color: "current", label: "This space", detail: here.label, value: here.id });
        rows.push({ key: "global", icon: "", label: "Global", detail: "shown everywhere", value: null });
        for (const sp of this.cfg.spaces) if (sp.id !== here?.id) rows.push({ key: sp.id, icon: "", label: sp.label, detail: tilde(expand(sp.path, this.home), this.home), value: sp.id });
        const r = await this.pick(cx, "Add command → Scope", rows);
        if (!r) return BACK;
        s.space = r.value;
      },
      async (s) => {
        const v = await this.prompt(cx, "Add command → Command", { value: s.command ?? "", help: "e.g. pnpm dev -p 3001", check: (x) => (x.trim() ? null : "Enter a command") });
        if (v == null) return BACK;
        s.command = v.trim();
      },
      async (s) => {
        const v = await this.prompt(cx, "Add command → Label", { value: s.label ?? C.cutLabel(s.command), check: (x) => (x.trim() ? null : "Enter a label") });
        if (v == null) return BACK;
        s.label = v.trim();
      },
      async (s) => {
        const r = await this.pick(cx, `"${s.label}" → Ask for space?`, [
          { key: "yes", icon: "+", color: "create", label: "Yes", detail: "Enter shows the space picker", value: true },
          { key: "no", icon: "+", color: "create", label: "No", detail: "Enter opens a new tab in the same space", value: false },
        ].sort((a, b) => ((b.value === !s.space) ? 1 : 0) - ((a.value === !s.space) ? 1 : 0)));
        if (!r) return BACK;
        s.askSpace = r.value;
      },
      async (s) => {
        const r = await this.pick(cx, `Pin "${s.label}" as a quick action?`, [
          { key: "no", icon: "", label: "No", value: false },
          { key: "yes", icon: "+", color: "create", label: "Yes", value: true },
        ]);
        if (!r) return BACK;
        await this.save((raw) => {
          const ref = C.addCommand(raw, s.space, { label: s.label, command: s.command, askSpace: s.askSpace });
          if (r.value) C.addPin(raw, { command: ref });
        });
      },
    ]);
    if (!st) return null;
    const where = st.space ? C.findSpace(this.cfg, st.space)?.label ?? st.space : "global";
    return `✓ Added "${st.label}" to ${where}`;
  }

  // ---- settings -------------------------------------------------------------------

  async setting(id, cx) {
    if (!this.cfg) return;
    let msg = null;
    if (id === "add-space") msg = await this.addSpaceFlow(cx);
    else if (id === "add-command") msg = await this.addCommandFlow(cx);
    else if (id === "manage-pins") this.managePins(cx);
    else if (id === "manage-commands") this.manageCommands(cx);
    else if (id === "shortcut") msg = await this.shortcutFlow(cx);
    else if (id === "open-config") await this.openConfigFile();
    if (msg) this.setStatus(msg);
  }

  managePins(cx) {
    const screen = {
      type: "list", title: "Manage quick actions", footer: "Enter options · Shift+↑↓ move · Esc done",
      build: () => {
        if (!this.cfg) return [];
        const snap = this.snap();
        const rows = this.cfg.quickActions.map((pin, i) => {
          const r = pinRow(this.cfg, pin, snap, this.ctx());
          const kindText = pin.kind === "builtin" ? ["built-in", r.detail].filter(Boolean).join(" · ") : r.detail;
          return { ...r, num: i + 1, detail: kindText };
        });
        rows.push({ key: "add", kind: "addPin", icon: "+", color: "create", label: "Add quick action…" });
        rows.push({ key: "reset", kind: "resetPins", icon: "↺", label: "Reset to defaults" });
        return [{ rows }];
      },
      onEnter: (row, cx) => this.managePinsEnter(row, cx),
      onTab: (row, cx) => this.managePinsEnter(row, cx),
      onMove: (row, d, cx) => {
        if (row.kind !== "pin") return;
        this.flow(cx, async () => {
          const to = await this.save((raw) => C.movePin(raw, row.pin.index, d));
          screen.selKey = `pin:${to}`;
          this.scrollToSel();
        });
      },
    };
    this.push(cx, screen);
  }

  managePinsEnter(row, cx) {
    if (row.kind === "addPin") return this.flow(cx, async (cx) => { const m = await this.addPinFlow(cx); if (m) this.setStatus(m); });
    if (row.kind === "resetPins") {
      return this.flow(cx, async (cx) => {
        if (!(await this.confirm(cx, "Reset quick actions to the defaults?", "New Claude tab · New tab · New space"))) return;
        await this.save((raw) => C.resetPins(raw));
        this.setStatus("✓ Quick actions reset");
      });
    }
    if (row.kind === "pin" && row.missing) {
      return this.flow(cx, async (cx) => {
        if (!(await this.confirm(cx, `Unpin "${row.label}"?`, "The item it pointed at no longer exists."))) return;
        await this.save((raw) => C.removePin(raw, row.pin.index));
        this.setStatus("✓ Unpinned");
      });
    }
    if (row.kind === "pin") this.openMenu(row, cx);
  }

  async addPinFlow(cx) {
    let label = null;
    const st = await this.steps(cx, [
      async (s) => {
        const r = await this.pick(cx, "Add quick action", [
          { key: "builtin", icon: "", label: "Built-ins", value: "builtin" },
          { key: "command", icon: "", label: "Commands", value: "command" },
          { key: "space", icon: "", label: "Spaces", value: "space" },
          { key: "action", icon: "", label: "Host actions", value: "action" },
        ]);
        if (!r) return BACK;
        s.kind = r.value;
      },
      async (s) => {
        let rows;
        const snap = this.snap();
        if (s.kind === "builtin") rows = Object.entries(C.BUILTINS).map(([k, v]) => ({ key: k, icon: "+", color: "create", label: v, value: k }));
        if (s.kind === "command") rows = [...this.cfg.commands, ...this.cfg.spaces.flatMap((x) => x.commands)].map((c) => ({ ...commandRow(this.cfg, c), value: c.ref }));
        if (s.kind === "space") rows = this.cfg.spaces.map((x) => ({ ...savedSpaceRow(x, snap), value: x.id }));
        if (s.kind === "action") rows = this.host.map((h) => ({ ...hostRow(h), value: h.name }));
        const r = await this.pick(cx, "Add quick action → Choose", rows);
        if (!r) return BACK;
        s.ref = r.value;
        label = r.label;
      },
    ]);
    if (!st) return null;
    await this.save((raw) => C.addPin(raw, { [st.kind]: st.ref }));
    return `✓ Pinned "${label}"`;
  }

  manageCommands(cx) {
    this.push(cx, {
      type: "list", title: "Manage commands", footer: "Enter options · Esc done",
      build: () => {
        if (!this.cfg) return [];
        return [
          { title: "Global", rows: this.cfg.commands.map((c) => commandRow(this.cfg, c)) },
          ...this.cfg.spaces.map((sp) => ({ title: sp.label, rows: sp.commands.map((c) => commandRow(this.cfg, c)) })),
        ].filter((s) => s.rows.length);
      },
      onEnter: (row, cx) => this.openCommandManageMenu(row, cx),
      onTab: (row, cx) => this.openCommandManageMenu(row, cx),
    });
  }

  openCommandManageMenu(row, cx) {
    const c = row.command;
    const moveTo = { label: "Move to…", icon: "→", act: async (cx) => {
      const rows = [{ key: "global", icon: "", label: "Global", value: null }, ...this.cfg.spaces.map((sp) => ({ key: sp.id, icon: "", label: sp.label, detail: sp.path, value: sp.id }))]
        .filter((r) => r.value !== (c.space ?? null));
      const r = await this.pick(cx, `${c.label} → Move to`, rows);
      if (!r) return;
      await this.save((raw) => C.moveCommand(raw, c.ref, r.value));
      return `✓ Moved "${c.label}" to ${r.label}`;
    } };
    this.openMenu(row, cx, this.commandMenu(c, [moveTo]));
  }

  async shortcutFlow(cx) {
    const ks = await this.ask(cx, { type: "record", title: "Shortcut → Press the new shortcut", footer: "Esc cancel" });
    if (!ks) return null;
    const warn = [];
    if (!/(cmd|ctrl|alt)-/.test(ks) && !/^f\d+$/.test(ks)) warn.push(`"${ks}" has no modifier, so it can't be typed anywhere else.`);
    if (unreachableShortcut(ks, this.platform)) warn.push(`"cmd" is the Super / Windows key here; the desktop usually takes "${ks}" before herdr-app sees it.`);
    const keysPath = `${appHome()}/keys.json`;
    const text = await readTextFile(keysPath);
    const keys = text ? JSON.parse(text) : {};
    const term = keys.terminal?.[ks];
    if (term) warn.push(`Terminals bind "${ks}" to ${term}: there it won't open the palette.`);
    if (/^ctrl-[a-z]$/.test(ks)) warn.push(`Shells use ${ks}; terminals won't receive it while the palette owns it.`);
    const other = keys.global?.[ks];
    if (other && other !== `mod.open:${MOD}`) warn.push(`"${ks}" is now ${other}; it will be replaced.`);
    if (warn.length && !(await this.confirm(cx, `Use ${ks}?`, warn.join("\n")))) return null;
    await this.writeShortcut(ks);
    await this.save((raw) => C.setShortcut(raw, ks, this.platform));
    return `✓ Shortcut is now ${ks}`;
  }

  // Binds `ks` to this palette in keys.json, removing older bindings to it.
  async writeShortcut(ks) {
    const keysPath = `${appHome()}/keys.json`;
    const text = await readTextFile(keysPath);
    const keys = text ? JSON.parse(text) : {};
    keys.global = keys.global ?? {};
    const action = `mod.open:${MOD}`;
    for (const [k, v] of Object.entries(keys.global)) if (v === action && k !== ks) delete keys.global[k];
    if (keys.global[ks] === action) return false;
    keys.global[ks] = action;
    await writeTextFile(keysPath, JSON.stringify(keys, null, 2) + "\n", text);
    return true;
  }

  // The config file's shortcut wins: re-applied when the palette opens.
  async syncShortcut() {
    if (!this.cfg || this.cfg.fatal || this.cfg.raw.shortcut === undefined) return;
    await this.writeShortcut(this.cfg.shortcut);
  }

  async openConfigFile() {
    const exists = await readTextFile(this.configPath).catch(() => null);
    if (exists == null) {
      const starter = { shortcut: defaultShortcut(this.platform), commands: [{ id: "claude", label: "Claude", command: "claude" }], spaces: [], quickActions: C.defaultQuickActions() };
      await writeTextFile(this.configPath, C.serialize(starter), null);
    }
    this.close();
    run("tab.new", { name: "palette config", folder: this.configDir, argv: [this.shell, "-ic", `\${EDITOR:-vi} ${JSON.stringify(this.configPath)}`] });
  }

  async showConfigErrors(cx) {
    const c = this.cfg;
    const lines = [c.fatal ? `The file can't be read: ${c.fatal}` : null, ...c.errors.map((e) => `Skipped ${e}`)].filter(Boolean);
    const r = await this.pick(cx, "Config error", [
      { key: "open", icon: "✎", label: "Open config file", value: "open" },
      { key: "back", icon: "", label: "Back", value: null },
    ], { message: `${tilde(this.configPath, this.home)}\n${lines.join("\n")}`, messageKind: "error" });
    if (r?.value === "open") await this.openConfigFile();
  }

  // ---- rendering --------------------------------------------------------------------

  color(t, name) {
    return {
      current: t.ansi2, create: t.ansi2, waiting: t.ansi3, danger: t.ansi1, warn: t.ansi3,
    }[name] ?? null;
  }

  renderRow(t, row, selected, searching) {
    const iconColor = this.color(t, row.color) ?? t.muted;
    // §4.2: the selected row gets the strong highlight, the hovered one a faint
    // one; the box is inset 1px top and bottom so neighbours never touch.
    const faint = /^#[0-9a-f]{6}$/i.test(t.hover) ? `${t.hover}59` : t.hover;
    const box = h_flex()
      .h(ROW_H - 2)
      .w_full()
      .px(8)
      .gap(8)
      .items_center()
      .rounded(6)
      .when(selected, (el) => el.bg(t.hover))
      .when(!selected, (el) => el.hover((st) => st.bg(faint)))
      .child(div().w(16).flex_none().text_color(iconColor).child(row.icon ?? ""))
      .when(searching && Boolean(typeIcon(row)), (el) => el.child(div().w(20).flex_none().child(typeIcon(row))))
      .when(row.num != null, (el) => el.child(div().w(16).flex_none().text_color(t.dim).child(String(row.num))))
      .child(div().flex_shrink_0().max_w(260).truncate().text_color(row.missing ? t.ansi3 : t.foreground).child(row.label))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(row.detail ?? ""))
      .when(Boolean(row.aside), (el) => el.child(div().flex_none().text_size(12).text_color(this.color(t, row.asideColor) ?? t.dim).child(row.aside)))
      .when(searching && Boolean(row.tag), (el) => el.child(div().flex_none().px(6).rounded(4).bg(t.raised).text_size(11).text_color(t.dim).child(row.tag)));
    return h_flex().h(ROW_H).mx(4).items_center().cursor_pointer().child(box);
  }

  renderList(t, s) {
    const { items, rows, total } = this.view(s);
    const sel = rows[s.sel];
    const searching = Boolean(s.query);
    // Element sizes follow the app zoom; a virtual list's item sizes don't.
    const z = Number(settings()?.zoom) || 1;
    const sizes = items.map((it) => (it.head ? HEAD_H : ROW_H) * z);
    const list = v_virtual_list("pal-list", items.length, sizes.length ? sizes : ROW_H * z, (i) => {
      const it = items[i];
      return it.head ? `h:${it.head}:${i}` : it.note ? `n:${i}` : it.row.key;
    }, (range) => items.slice(range.start, range.end).map((it) => {
      if (it.head) return h_flex().h(HEAD_H).px(12).pt(8).items_end().text_size(11).font_semibold().text_color(t.dim).child(it.head);
      if (it.note) return h_flex().h(ROW_H).px(36).items_center().text_size(12).text_color(t.dim).child(it.note);
      return this.renderRow(t, it.row, it.row.key === sel?.key, searching);
    })).track_scroll(this.scroll).size_full()
      .on_item_click((key, cx) => {
        const i = rows.findIndex((r) => r.key === key);
        if (i < 0) return;
        s.sel = i;
        s.selKey = key;
        s.onEnter?.(rows[i], cx, "enter");
        cx.notify();
      })
      .on_item_secondary_click((key, _e, cx) => {
        const i = rows.findIndex((r) => r.key === key);
        if (i < 0 || !s.onTab) return;
        s.sel = i;
        s.selKey = key;
        s.onTab(rows[i], cx);
        cx.notify();
      });

    const search = h_flex().h(34).flex_none().px(10).gap(6).items_center().rounded(8).border_1().border_color(t.input).bg(t.background)
      .child(div().text_color(t.dim).child(">"))
      .child(Input.new(this.fieldFor(s)).flex_1().h_full().text_color(t.foreground));

    return v_flex().flex_1().min_h(0).gap(8)
      .child(search)
      .when(Boolean(s.message), (el) => el.child(div().px(4).text_size(13).text_color(s.messageKind === "error" ? t.ansi1 : t.foreground).child(s.message)))
      .when(Boolean(s.hint), (el) => el.child(div().px(4).text_size(12).text_color(t.dim).child(s.hint)))
      .child(v_flex().relative().flex_1().min_h(0)
        .child(rows.length || items.length ? list : div().px(12).py(8).text_color(t.dim).child("No matches"))
        .child(Scrollbar.vertical("pal-list").absolute().inset_0()))
      .when(s.counter, (el) => el.child(h_flex().justify_end().text_size(11).text_color(t.dim).child(`${rows.length}/${total}`)));
  }

  renderPrompt(t, s) {
    return v_flex().flex_1().min_h(0).gap(6)
      .child(h_flex().h(34).flex_none().px(10).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.fields.prompt).flex_1().h_full().text_color(t.foreground)))
      .when(Boolean(s.note), (el) => el.child(div().px(4).text_size(12).text_color(t.ansi3).child(s.note)))
      .when(Boolean(s.help), (el) => el.child(div().px(4).text_size(12).text_color(t.dim).child(s.help)));
  }

  render(cx) {
    try {
      return this.renderInner(cx);
    } catch (e) {
      const t = theme();
      return v_flex().id("atd-palette").track_focus(this.handle).on_key_down((e, cx) => { if (e.key === "escape") this.close(); })
        .size_full().p(14).bg(t.popover).text_color(t.ansi1).child(`Palette render error: ${e?.message ?? e}`).child(div().text_size(11).child(String(e?.stack ?? "")));
    }
  }

  renderInner() {
    const t = theme();
    const s = this.top();
    const body = s.type === "list" ? this.renderList(t, s)
      : s.type === "prompt" ? this.renderPrompt(t, s)
      : v_flex().flex_1().items_center().justify_center().gap(6).child(div().text_size(14).text_color(t.foreground).child("Press the new shortcut…")).child(div().text_size(12).text_color(t.dim).child(`e.g. ${shortcutExample(this.platform)}`));
    const status = this.status;
    return v_flex()
      .id("atd-palette")
      .track_focus(this.handle)
      .key_context("AtdPalette")
      .on_action("atd-tab", (_e, cx) => this.onKey({ key: "tab", modifiers: {} }, cx))
      .on_key_down((e, cx) => this.onKey(e, cx))
      .size_full()
      .min_h(0)
      .p(14)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .text_color(t.foreground)
      .child(h_flex().flex_none().items_center()
        .child(div().flex_1().truncate().text_size(14).font_semibold().child(s.title))
        .child(div().text_size(11).text_color(t.dim).child(this.escHint())))
      .child(body)
      .when(Boolean(status), (el) => el.child(div().flex_none().px(4).text_size(12).text_color(status.kind === "error" ? t.ansi1 : t.ansi2).child(status.text)))
      .child(div().flex_none().pt(6).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).child(typeof s.footer === "function" ? s.footer(this.view(s).rows[s.sel]) : s.footer ?? ""));
  }
}

# Terminal "Run a Command" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The repo-card terminal button opens a menu: clean shell, or open a PTY terminal that runs one of the repo's start commands (detected `run_command` + command profiles), fire & forget.

**Architecture:** Backend gains ONE optional arg (`command`) on the existing `open_terminal_window` command; the command is typed-ahead into the PTY stdin (`<command>\r`) right after spawn. Frontend builds the menu with a pure function in `card-logic.ts` (tested), wires it through the existing `ContextMenuService`, and reuses the existing `openWindow` IPC wrapper with the new optional param. No supervision, no new IPC commands, no new state.

**Tech Stack:** Rust (Tauri 2), Angular 22 (signals, standalone), vitest.

**Spec:** `docs/superpowers/specs/2026-07-05-terminal-run-command-design.md`

## Global Constraints

- **NEVER run `git commit` / `git tag` / `git push`** — at the end of each task, print the exact commit command for the user to run manually. (User global rule.)
- **Never run `npm run build` or `npm run tauri build`.** (User global rule.) Verification = vitest + `cargo check` is NOT needed either; the user builds.
- i18n: `en.json` and `es.json` MUST keep identical key structure — every key added/changed in one is added/changed in the other.
- Layering: `core/` → `ui/` → `features/`. `card-logic.ts` may import TYPES from `../../../ui`; it must not import stores or IPC.
- No ESM cycles: run `npx madge --circular --extensions ts src/app` after the frontend changes; expect no cycles.
- IPC command COUNT does not change (only a new optional arg) — do NOT touch the count assertions in `src/app/core/ipc/commands.spec.ts`.
- Wire arg keys are camelCase; the new arg is `command` (single word, safe).

---

### Task 1: Backend — optional `command` arg on `open_terminal_window`

**Files:**
- Modify: `src-tauri/src/commands/terminal.rs:22-64`
- Modify: `docs/migration/ipc-contract.md:125`

**Interfaces:**
- Produces: `open_terminal_window { repoId, cwd, title, command?: string }` — when `command` is a non-empty string, it is written to the PTY stdin as `<command>\r` immediately after spawn (typeahead; the tty buffers it until the shell is ready).

- [ ] **Step 1: Add the `command` param and the typeahead write**

In `src-tauri/src/commands/terminal.rs`, replace the doc comment + signature + body of `open_terminal_window` (lines 22-45 region) so it reads:

```rust
/// `open_terminal_window { repoId, cwd, title, command? }` → allocate a
/// terminal id, spawn a PTY shell rooted at `cwd`, and open (focusing if it
/// somehow already exists) a detached `term-<id>` window loading
/// `?terminal=<id>`. Returns the new terminal id. Mirrors `open_log_window`.
///
/// When `command` is a non-empty string it is typed-ahead into the PTY
/// (`<command>\r`) right after spawn — the tty buffers the line until the
/// shell is ready, the command stays visible in the terminal, and Ctrl+C
/// leaves the user in a live interactive shell (design doc 2026-07-05).
#[tauri::command]
pub async fn open_terminal_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    repo_id: String,
    cwd: String,
    title: String,
    command: Option<String>,
) -> CmdResult<String> {
    let id = state.terminals.next_id(&repo_id);
    // Honor the Settings shell override (`AppConfig::terminal_shell`); fall
    // back to the per-platform default when unset/empty or config is unreadable.
    let override_shell = state.config.load().ok().and_then(|c| c.terminal_shell);
    let shell = resolve_shell(override_shell.as_deref());
    state.terminals.open(
        &id,
        &shell,
        std::path::Path::new(&cwd),
        DEFAULT_COLS,
        DEFAULT_ROWS,
    )?;
    if let Some(cmd) = command.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        state.terminals.write(&id, format!("{cmd}\r").as_bytes())?;
    }
```

The rest of the function (from `let label = window_label("term", &id);` to `Ok(id)`) is unchanged.

- [ ] **Step 2: Update the IPC contract doc**

In `docs/migration/ipc-contract.md` line 125, change the `open_terminal_window` row's args cell from `{ repoId: string, cwd: string, title: string }` to `{ repoId: string, cwd: string, title: string, command?: string }`, and append to its description: `; a non-empty \`command\` is typed-ahead (\`<command>\r\`) into the shell right after spawn`.

- [ ] **Step 3: Sanity check (no build)**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- src-tauri/src/commands/terminal.rs 2>/dev/null || true` (formatting only; skip on failure).
Do NOT run `cargo build`/`cargo test` (user rule: never build; Rust tests require an Angular build first).

- [ ] **Step 4: Hand the commit to the user (do NOT run it)**

```bash
git add src-tauri/src/commands/terminal.rs docs/migration/ipc-contract.md
git commit -m "feat(terminal): optional initial command typed-ahead into the PTY"
```

---

### Task 2: Frontend IPC wrapper — optional `command` param

**Files:**
- Modify: `src/app/core/ipc/commands.ts:824-831` (the `terminal.openWindow` method)

**Interfaces:**
- Consumes: Task 1's `open_terminal_window` wire contract.
- Produces: `commands.terminal.openWindow(repoId: string, cwd: string, title: string, command?: string): Promise<string>` — later tasks call it with 4 args; existing 3-arg callers stay valid.

- [ ] **Step 1: Add the optional param**

In `src/app/core/ipc/commands.ts`, replace the `openWindow` member of the `terminal` facade (currently lines 830-831) with:

```ts
    /**
     * Open a detached PTY terminal window for a repo (`cwd` = repo path).
     * Returns the new terminal id (`<repoId>::term::<n>`); the window's webview
     * then calls `attach` with that id. A non-empty `command` is typed-ahead
     * into the shell right after spawn (design doc 2026-07-05).
     */
    openWindow: (
      repoId: string,
      cwd: string,
      title: string,
      command?: string,
    ): Promise<string> =>
      this.bridge.invoke<string>(CMD.openTerminalWindow, { repoId, cwd, title, command }),
```

(`command: undefined` serializes to a missing key → Rust `None`.)

- [ ] **Step 2: Run the existing IPC specs to confirm nothing broke**

Run: `npx vitest run src/app/core/ipc/commands.spec.ts`
Expected: PASS (command count unchanged).

- [ ] **Step 3: Hand the commit to the user (do NOT run it)**

```bash
git add src/app/core/ipc/commands.ts
git commit -m "feat(ipc): optional command param on terminal.openWindow"
```

---

### Task 3: Pure menu builder in `card-logic.ts` (TDD)

**Files:**
- Modify: `src/app/features/workspace/repo-card/card-logic.ts`
- Test: `src/app/features/workspace/repo-card/card-logic.spec.ts`

**Interfaces:**
- Consumes: `MenuEntry` type from `../../../ui` (`{ id, label, icon?, disabled?, separator?, hint? }`; `separator: true` renders a divider ABOVE that item).
- Produces: `terminalMenuEntries(runCommand: string | undefined, profiles: Readonly<Record<string, string>>, text: { readonly shell: string; readonly detected: string }): MenuEntry[]`. Entry ids: `'shell'`, `'detected'`, `` `profile:<name>` ``. Task 4 resolves picks by these ids.

- [ ] **Step 1: Write the failing tests**

Append to `src/app/features/workspace/repo-card/card-logic.spec.ts` (add `terminalMenuEntries` to the existing import from `./card-logic`):

```ts
describe('terminalMenuEntries (terminal button menu, design 2026-07-05)', () => {
  const text = { shell: 'Terminal', detected: 'Run detected command' };

  it('always offers the clean shell first, alone when there are no commands', () => {
    expect(terminalMenuEntries(undefined, {}, text)).toEqual([
      { id: 'shell', label: 'Terminal', icon: 'terminal' },
    ]);
  });

  it('adds the detected command with a separator above the commands group', () => {
    const entries = terminalMenuEntries('npm start', {}, text);
    expect(entries[1]).toEqual({
      id: 'detected',
      label: 'Run detected command',
      icon: 'play',
      separator: true,
      hint: 'npm start',
    });
  });

  it('lists profiles sorted by name after the detected command', () => {
    const entries = terminalMenuEntries('npm start', { b: 'cmd b', a: 'cmd a' }, text);
    expect(entries.map((e) => e.id)).toEqual(['shell', 'detected', 'profile:a', 'profile:b']);
    expect(entries[2].separator).toBeUndefined();
    expect(entries[3].hint).toBe('cmd b');
  });

  it('puts the separator on the first profile when no run command is detected', () => {
    const entries = terminalMenuEntries(undefined, { a: 'cmd a' }, text);
    expect(entries[1]).toEqual({
      id: 'profile:a',
      label: 'a',
      icon: 'play',
      separator: true,
      hint: 'cmd a',
    });
  });

  it('truncates long commands in the hint to 40 chars with an ellipsis', () => {
    const entries = terminalMenuEntries('x'.repeat(60), {}, text);
    expect(entries[1].hint).toHaveLength(40);
    expect(entries[1].hint!.endsWith('…')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/features/workspace/repo-card/card-logic.spec.ts`
Expected: FAIL — `terminalMenuEntries` is not exported.

- [ ] **Step 3: Implement**

In `src/app/features/workspace/repo-card/card-logic.ts`, add at the top (the file currently has no imports):

```ts
import type { MenuEntry } from '../../../ui';
```

and append:

```ts
/** Right-aligned menu hint: the command itself, truncated so a long command
 * line cannot stretch the menu. */
function commandHint(command: string): string {
  return command.length > 40 ? `${command.slice(0, 39)}…` : command;
}

/**
 * Terminal-button menu (design doc 2026-07-05): "Terminal" (clean shell)
 * first, then — separated — the repo's start commands runnable fire & forget
 * in a terminal: the detected run command (when present) and every saved
 * command profile, sorted by name. Ids: `shell` | `detected` | `profile:<name>`.
 */
export function terminalMenuEntries(
  runCommand: string | undefined,
  profiles: Readonly<Record<string, string>>,
  text: { readonly shell: string; readonly detected: string },
): MenuEntry[] {
  const commands: MenuEntry[] = [];
  if (runCommand) {
    commands.push({
      id: 'detected',
      label: text.detected,
      icon: 'play',
      hint: commandHint(runCommand),
    });
  }
  for (const name of Object.keys(profiles).sort((a, b) => a.localeCompare(b))) {
    commands.push({
      id: `profile:${name}`,
      label: name,
      icon: 'play',
      hint: commandHint(profiles[name]),
    });
  }
  if (commands.length > 0) {
    commands[0] = { ...commands[0], separator: true };
  }
  return [{ id: 'shell', label: text.shell, icon: 'terminal' }, ...commands];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/features/workspace/repo-card/card-logic.spec.ts`
Expected: PASS (all describes, old and new).

- [ ] **Step 5: Hand the commit to the user (do NOT run it)**

```bash
git add src/app/features/workspace/repo-card/card-logic.ts src/app/features/workspace/repo-card/card-logic.spec.ts
git commit -m "feat(repo-card): terminalMenuEntries builder for the terminal button menu"
```

---

### Task 4: i18n — tooltip rename + new menu key

**Files:**
- Modify: `src/assets/i18n/en.json:113` and the `menu` block (~line 741)
- Modify: `src/assets/i18n/es.json:113` and the `menu` block (~line 741)

**Interfaces:**
- Produces: changed `tooltip.open_terminal`; new key `menu.run_detected`. Task 5 consumes `menu.run_detected` and the existing `label.terminal`.

- [ ] **Step 1: Edit `en.json`**

Line 113: `"open_terminal": "Open a terminal in this repo"` → `"open_terminal": "Terminal / run a command"`.

In the `menu` block, after `"open_terminal": "Open terminal here",` add:

```json
    "run_detected": "Run detected command",
```

- [ ] **Step 2: Edit `es.json` (same structure, same positions)**

Line 113: `"open_terminal": "Abrir una terminal en este repo"` → `"open_terminal": "Terminal / ejecutar un comando"`.

In the `menu` block, after `"open_terminal": "Abrir terminal aquí",` add:

```json
    "run_detected": "Ejecutar comando detectado",
```

- [ ] **Step 3: Verify key parity**

Run: `node -e "const a=Object.keys(require('./src/assets/i18n/en.json').menu),b=Object.keys(require('./src/assets/i18n/es.json').menu);console.log(JSON.stringify(a)===JSON.stringify(b)?'OK':'MISMATCH')"`
Expected: `OK`

- [ ] **Step 4: Hand the commit to the user (do NOT run it)**

```bash
git add src/assets/i18n/en.json src/assets/i18n/es.json
git commit -m "feat(i18n): terminal button tooltip + run-detected menu entry"
```

---

### Task 5: Wire the menu into the repo card

**Files:**
- Modify: `src/app/features/workspace/repo-card/card-header.component.ts:166-170` (button) and `:220-221` (output)
- Modify: `src/app/features/workspace/repo-card/repo-card.component.ts` (template line 104, imports line ~52, handlers lines 530-539 and 600)

**Interfaces:**
- Consumes: `terminalMenuEntries` (Task 3), `commands.terminal.openWindow(repoId, cwd, title, command?)` (Task 2), keys `menu.run_detected` / `label.terminal` (Task 4). Existing: `ContextMenuService.openFromEvent(ev: MouseEvent, items: readonly MenuEntry[]): Promise<string | null>`; `ui-icon-button`'s `clicked` output emits `MouseEvent`; `this.cmdProfilesLoaded` / `loadCommandProfiles()` / `this.commandProfiles()` already exist in the component.
- Produces: `openTerminal` output now carries `MouseEvent`.

- [ ] **Step 1: card-header — emit the MouseEvent**

In `card-header.component.ts`, change the terminal button (lines 166-170) to forward the click event:

```html
          <ui-icon-button
            variant="neutral"
            [uiTooltip]="text().openTerminalTip"
            (clicked)="openTerminal.emit($event)"
          ><ui-icon name="terminal" /></ui-icon-button>
```

and change the output declaration (lines 220-221) to:

```ts
  /** Terminal button click — the container opens the terminal/commands menu
   * anchored on the event (design doc 2026-07-05). */
  readonly openTerminal = output<MouseEvent>();
```

- [ ] **Step 2: repo-card — menu handler + extracted open helper**

In `repo-card.component.ts`:

(a) Template line 104: `(openTerminal)="onOpenTerminal()"` → `(openTerminal)="onOpenTerminal($event)"`.

(b) Add `terminalMenuEntries` to the existing `./card-logic` import list (line ~46-57, keep alphabetical order: after `serviceUrl` is fine, but the list is alphabetical — insert between `serviceUrl,` and the closing brace as `terminalMenuEntries,`).

(c) Replace `onOpenTerminal` (lines 530-539) with:

```ts
  /** Terminal button (design doc 2026-07-05): menu with a clean shell plus
   * the repo's start commands, each opening a fire & forget PTY terminal. */
  protected async onOpenTerminal(event: MouseEvent): Promise<void> {
    if (!this.cmdProfilesLoaded) {
      await this.loadCommandProfiles();
    }
    const entries = terminalMenuEntries(
      this.repo().runCommand,
      this.commandProfiles(),
      {
        shell: this.i18n.t('label.terminal'),
        detected: this.i18n.t('menu.run_detected'),
      },
    );
    const picked = await this.menu.openFromEvent(event, entries);
    if (picked === 'shell') {
      this.openTerminalWindow();
    } else if (picked === 'detected') {
      this.openTerminalWindow(this.repo().runCommand, this.repo().runCommand);
    } else if (picked?.startsWith('profile:')) {
      const name = picked.slice('profile:'.length);
      const cmd = this.commandProfiles()[name];
      if (cmd) {
        this.openTerminalWindow(cmd, name);
      }
    }
  }

  /** Open the detached PTY window rooted at the repo; a non-empty `command`
   * is typed-ahead into the shell (fire & forget — no supervision). */
  private openTerminalWindow(command?: string, titleLabel?: string): void {
    void this.commands.terminal
      .openWindow(
        this.repo().name,
        this.repo().path,
        `${this.repo().name} — ${titleLabel ?? this.i18n.t('label.terminal')}`,
        command,
      )
      .catch((err: unknown) => console.error('open terminal window failed', err));
  }
```

(d) Header context menu stays a clean shell: line 600, `case 'terminal': return this.onOpenTerminal();` → `case 'terminal': return this.openTerminalWindow();`.

Note: `RepoInfo.runCommand` is `readonly runCommand?: string` (`tauri.types.ts:411`) — `string | undefined`, which matches `terminalMenuEntries`' first param exactly.

- [ ] **Step 3: Full frontend test run + cycle check**

Run: `npx vitest run`
Expected: PASS.
Run: `npx madge --circular --extensions ts src/app`
Expected: `✔ No circular dependency found!`

- [ ] **Step 4: Hand the commit to the user (do NOT run it)**

```bash
git add src/app/features/workspace/repo-card/card-header.component.ts src/app/features/workspace/repo-card/repo-card.component.ts
git commit -m "feat(repo-card): terminal button menu — clean shell or run a start command"
```

---

### Task 6: Manual verification (user-driven)

**Files:** none.

- [ ] **Step 1: Ask the user to verify in dev mode**

The user runs `npm run tauri dev` (native Windows recommended) and checks:
1. Terminal button on a repo card → menu shows "Terminal" + detected command (hint shows the command) + profiles sorted.
2. Picking a command opens the terminal, the command line appears typed and runs; window title is `<repo> — <name>`.
3. Ctrl+C in that terminal leaves a usable shell; closing the window kills the process tree (existing `close_terminal` behavior).
4. Picking "Terminal" and the header right-click → "Open terminal here" both open a clean shell.
5. A repo with no detected command and no profiles: menu shows only "Terminal".

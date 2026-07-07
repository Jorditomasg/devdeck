/**
 * Pure presentation logic for the repo card, extracted for unit testing
 * (card-logic.spec.ts):
 * - type-badge label casing (inventory-gui.md §6 item 3)
 * - header hint concatenation (§6 item 5 `_branch_hint`)
 * - danger-env detection (§10 `_update_danger_badge`)
 * - docker compose button state/counter (§7 row 3.5, §11)
 * - detected service URL (§9 `_detect_port_from_log` consumer)
 */
import type { MenuEntry } from '../../../ui';
import type { ServiceStatus } from '../../../core/ipc/tauri.types';

/** `"spring-boot"` → `"Spring Boot"` (§6 type badge: title-cased, `-`→space). */
export function repoTypeLabel(repoType: string): string {
  return repoType
    .split('-')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/**
 * Header hint (§6 `_branch_hint`): up to three fragments separated by three
 * spaces — `⎇ <branch>`, `⚙ <profile>`, `$ <command>`; empty fragments are
 * dropped.
 */
export function headerHint(
  branch: string,
  profileValue: string,
  command: string,
): string {
  const parts: string[] = [];
  if (branch) {
    parts.push(`⎇ ${branch}`);
  }
  if (profileValue) {
    parts.push(`⚙ ${profileValue}`);
  }
  if (command) {
    parts.push(`$ ${command}`);
  }
  return parts.join('   ');
}

/**
 * Command shown in the `$` hint fragment (§6): a selected command profile
 * overrides the detected run command — mirrors the Rust start resolution
 * (`resolved_command_override` in commands/process.rs).
 */
export function effectiveCommand(
  profiles: Readonly<Record<string, string>>,
  selectedProfile: string,
  runCommand: string | undefined,
): string {
  return (selectedProfile && profiles[selectedProfile]) || runCommand || '';
}

/** First non-empty saved-environment selection (the `⚙` hint fragment, §6). */
export function firstConfigValue(
  configValues: Readonly<Record<string, string>>,
  moduleKeys: readonly string[],
): string {
  for (const key of moduleKeys) {
    const value = configValues[key];
    if (value) {
      return value;
    }
  }
  return '';
}

/**
 * Danger-env badge rule (§10): shown when ANY module's active saved
 * environment is in the repo's danger set (`RepoInfo.dangerFlags`).
 */
export function dangerEnvActive(
  configValues: Readonly<Record<string, string>>,
  dangerFlags: readonly string[],
): boolean {
  if (dangerFlags.length === 0) {
    return false;
  }
  return Object.values(configValues).some(
    (name) => name !== '' && dangerFlags.includes(name),
  );
}

/** Expand-panel config affordances gated by `RepoInfo.configEditable` (§7). */
export interface ConfigAffordances {
  /** Per-module environment selector rows (only with editable config + files). */
  readonly hasEnvRows: boolean;
  /** Standalone "Config" button — shown when editable but there are no env rows. */
  readonly showConfigBtn: boolean;
  /** Custom run-command entry row (shown whenever config is editable). */
  readonly showCmdRow: boolean;
}

/**
 * §7 config-row gating, keyed on `RepoInfo.configEditable`: non-editable repos
 * (e.g. docker-infra) get no env rows, no config button, no command row.
 * Env rows need both editable config AND at least one environment file.
 *
 * The standalone "Config" button is intentionally NOT shown for editable repos
 * that have no environment files (user request): with nothing to configure it
 * was confusing (e.g. DevDeck's own Angular repo). Editing still happens
 * through the env selector rows when there ARE env files.
 */
export function configAffordances(
  configEditable: boolean,
  envFileCount: number,
): ConfigAffordances {
  const hasEnvRows = envFileCount > 0 && configEditable;
  return {
    hasEnvRows,
    showConfigBtn: false,
    showCmdRow: configEditable,
  };
}

/** Docker compose button visual state (§7 row 3.5 colors). */
export type DockerBtnState = 'running' | 'active' | 'stopped';

/**
 * §7 row 3.5: running>0 → green; 0 running but file active in the profile →
 * blue; otherwise grey. `null` counts (status unknown) count as 0 running.
 */
export function dockerButtonState(
  runningCount: number | null,
  activeInProfile: boolean,
): DockerBtnState {
  if ((runningCount ?? 0) > 0) {
    return 'running';
  }
  return activeInProfile ? 'active' : 'stopped';
}

/** `[running/total]` counter text; `[?/?]` before the first status fetch (§7). */
export function composeCountsLabel(
  counts: { running: number; total: number } | null,
): string {
  return counts ? `[${counts.running}/${counts.total}]` : '[?/?]';
}

/**
 * Card-level status of a docker-managed repo (§11): running containers in
 * any active compose file ⇒ `running`, else `stopped` (docker repos have no
 * supervised process).
 */
export function dockerCardStatus(runningServices: number): ServiceStatus {
  return runningServices > 0 ? 'running' : 'stopped';
}

/**
 * Browser URL of a running service — the clickable port affordance of the
 * card log header (§8 task spec). `null` when no port is known.
 */
export function serviceUrl(
  port: number | undefined,
  contextPath: string | undefined,
): string | null {
  if (!port) {
    return null;
  }
  const ctx = contextPath
    ? contextPath.startsWith('/')
      ? contextPath
      : `/${contextPath}`
    : '';
  return `http://localhost:${port}${ctx}`;
}

/** Path basename (both separators — v1 ran on Windows paths). */
export function pathBasename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

/**
 * Terminal-button menu (design doc 2026-07-05): "Terminal" (clean shell)
 * first, then — separated — the repo's saved command profiles (sorted by
 * name), each runnable fire & forget in a terminal; and last, separated at
 * the bottom, an "add command" entry that opens the command-profile manager.
 * Ids: `shell` | `profile:<name>` | `add`.
 */
export function terminalMenuEntries(
  profiles: Readonly<Record<string, string>>,
  text: { readonly shell: string; readonly add: string },
): MenuEntry[] {
  const commands: MenuEntry[] = [];
  for (const name of Object.keys(profiles).sort((a, b) => a.localeCompare(b))) {
    commands.push({
      id: `profile:${name}`,
      label: name,
      icon: 'play',
      title: profiles[name],
    });
  }
  if (commands.length > 0) {
    commands[0] = { ...commands[0], separator: true };
  }
  return [
    { id: 'shell', label: text.shell, icon: 'terminal' },
    ...commands,
    { id: 'add', label: text.add, icon: 'plus', separator: true },
  ];
}

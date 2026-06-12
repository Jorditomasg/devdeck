/**
 * Pure presentation logic for the repo card, extracted for unit testing
 * (card-logic.spec.ts):
 * - type-badge label casing (inventory-gui.md §6 item 3)
 * - header hint concatenation (§6 item 5 `_branch_hint`)
 * - danger-env detection (§10 `_update_danger_badge`)
 * - docker compose button state/counter (§7 row 3.5, §11)
 * - detected service URL (§9 `_detect_port_from_log` consumer)
 */
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

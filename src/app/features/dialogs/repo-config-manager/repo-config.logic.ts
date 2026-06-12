/**
 * Pure logic of the Repo Config Manager dialog (inventory-gui §23) — the
 * config-driven environment-name derivation of v1
 * `config_manager._profile_name_from_file` / `auto_import_configs`
 * (core/config_manager.py:257-317) plus the danger-set toggle
 * (`set_danger_flags` stores names sorted, ipc-contract.md §2.5 #32).
 */

/**
 * Derive an environment name from a filename using the repo-type glob
 * patterns (`env_patterns`): the wildcard remainder with leading `-._`
 * separators stripped, e.g.
 *
 * - `application*.yml` + `application-dev.yml` → `dev`
 * - `environment*.ts` + `environment.production.ts` → `production`
 * - `.env*` + `.env.local` → `local`
 *
 * Falls back to `default` when the remainder is empty or no pattern matches
 * (v1 code behavior — the v1 docstring's "skip" was never implemented).
 */
export function envNameFromFile(
  basename: string,
  envPatterns: readonly string[],
): string {
  for (const pattern of envPatterns) {
    const captured = matchGlobCapture(pattern, basename);
    if (captured === null) {
      continue;
    }
    const name = captured.replace(/^[-._]+/, '');
    return name !== '' ? name : 'default';
  }
  return 'default';
}

/**
 * Match `basename` against a glob `pattern`; returns the FIRST wildcard
 * capture (v1 `m.group(1)`), `''` for a wildcard-free exact match, or `null`
 * when the pattern does not match.
 */
function matchGlobCapture(pattern: string, basename: string): string | null {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) =>
    ch === '*' ? '(.*)' : `\\${ch}`,
  );
  const match = new RegExp(`^${escaped}$`).exec(basename);
  if (!match) {
    return null;
  }
  return match[1] ?? '';
}

/**
 * Auto-import merge plan: only candidates whose name is NOT already saved
 * are added (v1 §23 "adds only NEW names"). Returns the additions only.
 */
export function newConfigEntries(
  candidates: Readonly<Record<string, string>>,
  existingNames: readonly string[],
): Readonly<Record<string, string>> {
  const taken = new Set(existingNames);
  return Object.fromEntries(
    Object.entries(candidates).filter(([name]) => !taken.has(name)),
  );
}

/** Toggle `name` in the danger set; result deduplicated and sorted (§2.5 #32). */
export function toggleDangerName(
  names: readonly string[],
  name: string,
): readonly string[] {
  const set = new Set(names);
  if (set.has(name)) {
    set.delete(name);
  } else {
    set.add(name);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Swap `from` for `to` in the danger set (rename/duplicate bookkeeping). */
export function renameDangerName(
  names: readonly string[],
  from: string,
  to: string,
): readonly string[] {
  if (!names.includes(from)) {
    return names;
  }
  return toggleDangerName(toggleDangerName(names, from), to);
}

/** Last path segment (both separators — repo paths may be Windows-style). */
export function basenameOf(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

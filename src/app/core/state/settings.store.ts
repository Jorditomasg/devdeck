/**
 * App config mirror — language, workspace groups, JDK registry, tray
 * behavior. Loads the whole `AppConfig` once via `get_app_config`, then keeps
 * the local signal in sync after every granular setter (the Rust
 * `ConfigStore` is the source of truth; this is a write-through mirror).
 *
 * The group-fallback semantics live here as exported pure functions so they
 * stay unit-testable.
 */
import { Injectable, computed, signal } from '@angular/core';

import { IpcCommands } from '../ipc/commands';
import { IpcEvents } from '../ipc/events';
import type {
  AppConfig,
  RepoState,
  SingleInstanceEvent,
  WorkspaceGroup,
} from '../ipc/tauri.types';

/** The stored workspace groups (empty until configured). */
export function workspaceGroupsOrDefault(
  config: AppConfig | null,
): readonly WorkspaceGroup[] {
  return config?.workspace_groups ?? [];
}

/**
 * `active_group` when it names an existing group, otherwise the first group
 * (tolerates a dangling `active_group`, e.g. a group deleted while active).
 */
export function effectiveActiveGroup(
  config: AppConfig | null,
): WorkspaceGroup | undefined {
  const groups = workspaceGroupsOrDefault(config);
  const wanted = config?.active_group;
  return groups.find((g) => g.name === wanted) ?? groups[0];
}

@Injectable({ providedIn: 'root' })
export class SettingsStore {
  private readonly _config = signal<AppConfig | null>(null);
  private readonly _singleInstance = signal<SingleInstanceEvent | null>(null);

  /** The raw config mirror (`null` until {@link load} resolves). */
  readonly config = this._config.asReadonly();

  /** v1 language code (`en_EN` / `es_ES`); v1 default is `en_EN`. */
  readonly language = computed(() => this._config()?.language ?? 'en_EN');

  /** Minimize-to-tray with the v1 default `true` (§8.3 backend). */
  readonly minimizeToTray = computed(
    () => this._config()?.minimize_to_tray ?? true,
  );

  /** JDK registry: display label → JAVA_HOME path. */
  readonly javaVersions = computed<Readonly<Record<string, string>>>(
    () => this._config()?.java_versions ?? {},
  );

  /** Effective workspace groups (with the §8.7 Default synthesis). */
  readonly workspaceGroups = computed(() =>
    workspaceGroupsOrDefault(this._config()),
  );

  /** Effective active group (with the §8.3 dangling-name fallback). */
  readonly activeGroup = computed(() => effectiveActiveGroup(this._config()));

  /** Per-repo persisted UI state. */
  readonly repoStates = computed<Readonly<Record<string, RepoState>>>(
    () => this._config()?.repo_state ?? {},
  );

  /** Shell command for new terminals (`''` = per-platform default). */
  readonly terminalShell = computed(() => this._config()?.terminal_shell ?? '');

  /** Last loaded profile name for the active group (`''` = none). */
  readonly lastProfileForActiveGroup = computed(() => {
    const group = this.activeGroup()?.name;
    if (!group) {
      return '';
    }
    return this._config()?.last_profile_by_group?.[group] ?? '';
  });

  /**
   * Latest `app://single-instance` payload (second launch forwarding).
   *
   * Consumed by the workspace page, which shows DevDeck's own styled
   * "already running" prompt (`dialog-service.confirmSecondInstance`) and
   * restores the window on confirm — the Rust callback no longer shows a
   * native dialog. The argv/cwd it carries is still available for future
   * forwarding (e.g. a second launch passing a workspace path).
   */
  readonly singleInstance = this._singleInstance.asReadonly();

  constructor(
    private readonly commands: IpcCommands,
    private readonly events: IpcEvents,
  ) {}

  /** Subscribe events + initial config load. Called from the app initializer. */
  async init(): Promise<void> {
    await this.events.onAppSingleInstance((e) => this._singleInstance.set(e));
    // Re-sync whenever ANY window persists a config change (config dialogs run
    // in their own windows — docs/migration/dialogs-as-windows.md Phase 3).
    await this.events.onConfigChanged((config) => this._config.set(config));
    await this.load();
  }

  /** (Re)load the whole config from Rust. */
  async load(): Promise<AppConfig> {
    const config = await this.commands.config.getAppConfig();
    this._config.set(config);
    return config;
  }

  // -- setters (persist via IPC, then mirror locally) -------------------------

  /** Persist a v1 language code (`en_EN` / `es_ES`). */
  async setLanguage(language: string): Promise<void> {
    await this.commands.config.setLanguage(language);
    this.patch({ language });
  }

  async setMinimizeToTray(value: boolean): Promise<void> {
    await this.commands.config.setMinimizeToTray(value);
    this.patch({ minimize_to_tray: value });
  }

  /**
   * Persist the shell command for new terminals (`''`/`null` → per-platform
   * default). Saved via the terminal command group; `config://changed` keeps
   * every window in sync (the local patch is just for immediacy).
   */
  async setTerminalShell(shell: string | null): Promise<void> {
    const value = shell?.trim() ? shell.trim() : null;
    await this.commands.terminal.setShell(value);
    this.patch({ terminal_shell: value ?? undefined });
  }

  async setActiveGroup(name: string): Promise<void> {
    await this.commands.config.setActiveGroup(name);
    this.patch({ active_group: name });
  }

  /**
   * Persist the last loaded profile of a group (`last_profile_by_group` —
   * the §26 startup re-apply source). `group: null` = Default group;
   * `name: null` = the no-profile sentinel (clears the entry).
   */
  async setLastProfile(group: string | null, name: string | null): Promise<void> {
    await this.commands.config.setLastProfile(group, name);
    // Mirror under the group's DISPLAY name — `lastProfileForActiveGroup`
    // keys by `activeGroup().name`, where the Default group is 'Default'.
    const key = group ?? 'Default';
    const current = this._config()?.last_profile_by_group ?? {};
    this.patch({ last_profile_by_group: { ...current, [key]: name ?? '' } });
  }

  async saveWorkspaceGroups(groups: readonly WorkspaceGroup[]): Promise<void> {
    await this.commands.config.saveWorkspaceGroups(groups);
    this.patch({ workspace_groups: groups });
  }

  /** Replace one repo's persisted UI state wholesale. */
  async setRepoState(repo: string, state: RepoState): Promise<void> {
    await this.commands.config.setRepoState(repo, state);
    const current = this._config()?.repo_state ?? {};
    this.patch({ repo_state: { ...current, [repo]: state } });
  }

  /** Whole-map replace of the JDK registry (`java_versions`). */
  async saveJavaVersions(
    versions: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.commands.java.saveJavaVersions(versions);
    this.patch({ java_versions: versions });
  }

  /** Filesystem JDK scan (label → JAVA_HOME); does NOT persist by itself. */
  detectJdks(): Promise<Record<string, string>> {
    return this.commands.java.detectJdks();
  }

  private patch(partial: Partial<AppConfig>): void {
    this._config.update((config) =>
      config ? { ...config, ...partial } : (partial as AppConfig),
    );
  }
}

/**
 * Repo-level action flows shared by the card containers and the GlobalPanel
 * batch controls (inventory-gui.md §12 "RepoCard — actions", §3) — the v2
 * equivalent of v1 `gui/repo_card/_actions.py` + `_git.py` flows.
 *
 * Confirmation/error UX goes through `DialogService` (the dialogs feature);
 * optimistic status flips live in `ServicesStore` (start/stop already patch
 * before the IPC resolves); operation log lines arrive from Rust via
 * `service://log-line` (`stream: "git" | "docker"`, ipc-contract.md §2.4) —
 * the frontend no longer fabricates log lines.
 */
import { Injectable, signal } from '@angular/core';

import { IpcCommands } from '../../../core/ipc/commands';
import { isAppError } from '../../../core/ipc/tauri.types';
import type { ProfileDocument, RepoInfo } from '../../../core/ipc/tauri.types';
import { ReposStore } from '../../../core/state/repos.store';
import { ServicesStore } from '../../../core/state/services.store';
import { DialogService } from '../../dialogs/dialog.service';
import { TranslationService } from '../../../core/i18n/translation.service';
import { runBatch } from '../batch';
import {
  DOCKER_RESTART_DELAY_MS,
  GIT_BATCH_CONCURRENCY,
  PULL_ERROR_MAX_FILES,
} from '../workspace.constants';
import { WorkspaceStore, configKeyFor } from './workspace.store';
import { driftedModules, type EnvDriftInput } from '../workspace-logic';

/** v1 gate for docker-managed cards (§12 step 1): the `docker_checkboxes` feature. */
export function isDockerRepo(repo: RepoInfo): boolean {
  return repo.features.includes('docker_checkboxes') && repo.dockerComposeFiles.length > 0;
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

@Injectable({ providedIn: 'root' })
export class RepoActionsService {
  /**
   * Repos with a pull in flight. Guards re-entry (two concurrent `git pull`s
   * fail with "Cannot fast-forward to multiple branches") and drives the
   * disabled state of the pull buttons.
   */
  private readonly _pulling = signal<ReadonlySet<string>>(new Set());
  readonly pulling = this._pulling.asReadonly();

  /**
   * Env selections auto-deselected because their file drifted (§10). Feeds the
   * workspace-page banner; `dismissDriftNotices` clears it. Deselected modules
   * are skipped on the next check, so no entry re-appears once acknowledged.
   */
  private readonly _driftNotices = signal<
    readonly { repo: string; moduleKey: string }[]
  >([]);
  readonly driftNotices = this._driftNotices.asReadonly();

  dismissDriftNotices(): void {
    this._driftNotices.set([]);
  }

  constructor(
    private readonly commands: IpcCommands,
    private readonly services: ServicesStore,
    private readonly repos: ReposStore,
    private readonly ws: WorkspaceStore,
    private readonly dialogs: DialogService,
    private readonly i18n: TranslationService,
  ) {}

  // -- lifecycle (§12) --------------------------------------------------------

  /**
   * Start a repo: docker repos go through compose-up of the active files;
   * process repos through `start_service` with custom command / java
   * overrides (§12 "Start").
   */
  async start(repo: RepoInfo): Promise<void> {
    if (isDockerRepo(repo)) {
      await this.startDocker(repo);
      return;
    }
    const opts = this.startOverrides(repo);
    if (!repo.runCommand && !this.ws.card(repo.name).selectedCommandProfile) {
      await this.dialogs.warning(
        this.i18n.t('misc.warning_title'),
        this.i18n.t('log.no_start_command', { name: repo.name }),
      );
      return;
    }
    await this.runLifecycle(repo, () => this.services.start(repo.name, opts));
  }

  async stop(repo: RepoInfo): Promise<void> {
    if (isDockerRepo(repo)) {
      await this.stopDocker(repo);
      return;
    }
    await this.runLifecycle(repo, () => this.services.stop(repo.name));
  }

  /**
   * Restart: docker → stop then start after 2000 ms (§28 card restart delay,
   * docker); process repos → `restart_service` (Rust applies the 300 ms
   * process delay, ipc-contract.md §2.3 #5).
   */
  async restart(repo: RepoInfo): Promise<void> {
    if (isDockerRepo(repo)) {
      await this.stopDocker(repo);
      setTimeout(() => void this.startDocker(repo), DOCKER_RESTART_DELAY_MS);
      return;
    }
    await this.runLifecycle(repo, () =>
      this.services.restart(repo.name, this.startOverrides(repo)),
    );
  }

  /**
   * Install dependencies (§12 "Install"). `fromButton` asks the reinstall
   * confirmation (v1 asked only when already installed; without an
   * install-state command the v2 heuristic is: confirm whenever a dedicated
   * reinstall command exists — see integration notes).
   */
  async install(repo: RepoInfo, fromButton: boolean): Promise<boolean> {
    if (!repo.runInstallCmd) {
      return false;
    }
    let reinstall = false;
    if (fromButton && repo.runReinstallCmd) {
      reinstall = await this.dialogs.confirm(
        this.i18n.t('dialog.reinstall.title'),
        this.i18n.t('dialog.reinstall.confirm'),
      );
      if (!reinstall) {
        return false;
      }
    }
    const java = this.startOverrides(repo).javaLabel;
    const ok = await this.runLifecycle(repo, () =>
      this.services.install(repo.name, reinstall, java),
    );
    return ok;
  }

  /**
   * Run a process lifecycle dispatch (start/stop/restart/install) and surface a
   * failure as the standard error dialog instead of letting the rejection vanish
   * into the card's `void this.actions.x()` call. The store has already reverted
   * the optimistic status by the time we get here. Returns whether it succeeded.
   */
  private async runLifecycle(
    repo: RepoInfo,
    run: () => Promise<void>,
  ): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (err: unknown) {
      const msg = isAppError(err) ? err.message : String(err);
      await this.dialogs.error(
        this.i18n.t('misc.error_title'),
        this.i18n.t('misc.action_failed', { name: repo.name, msg }),
      );
      return false;
    }
  }

  // -- git (§9, §12) -----------------------------------------------------------

  /**
   * Pull flow (§12 "Pull"): blocked with an error listing up to 10 dirty
   * files (ignoring `env_pull_ignore_patterns`); confirmed when commits are
   * pending; silent pull otherwise. Returns true when a pull ran.
   */
  async pull(repo: RepoInfo): Promise<boolean> {
    if (this._pulling().has(repo.name)) {
      return false;
    }
    this.setPulling(repo.name, true);
    try {
      const changes = await this.commands.git.localChanges(
        repo.path,
        repo.envPullIgnorePatterns,
      );
      if (changes.length > 0) {
        const listed = changes.slice(0, PULL_ERROR_MAX_FILES).join('\n');
        const suffix = changes.length > PULL_ERROR_MAX_FILES ? '\n...' : '';
        await this.dialogs.error(
          this.i18n.t('dialog.pull.error_title'),
          this.i18n.t('dialog.pull.error_msg', {
            name: repo.name,
            changes: `${listed}${suffix}`,
          }),
        );
        return false;
      }
      const badge = this.repos.badges()[repo.name];
      const behind = badge?.behind ?? 0;
      if (behind > 0) {
        const ok = await this.dialogs.confirm(
          this.i18n.t('dialog.pull.confirm_title'),
          this.i18n.t('dialog.pull.confirm_msg', {
            commits: behind,
            branch: badge?.branch ?? this.ws.card(repo.name).branch,
          }),
        );
        if (!ok) {
          return false;
        }
      }
      await this.commands.git.pull(repo.path);
      await this.refreshGitState(repo);
      return true;
    } finally {
      this.setPulling(repo.name, false);
    }
  }

  private setPulling(name: string, on: boolean): void {
    this._pulling.update((current) => {
      const next = new Set(current);
      if (on) {
        next.add(name);
      } else {
        next.delete(name);
      }
      return next;
    });
  }

  /**
   * Checkout flow (§9 `_on_branch_change` + task spec confirm-if-dirty):
   * uncommitted changes ask for confirmation first; a failed checkout shows
   * the v1 error dialog. Returns true when the branch actually switched —
   * callers revert the combo otherwise (programmatic select writes never
   * re-emit, ui-searchable-select contract).
   */
  async checkout(repo: RepoInfo, branch: string): Promise<boolean> {
    const state = this.ws.card(repo.name);
    if (!branch || branch === state.branch) {
      return false;
    }
    const unstaged = this.repos.badges()[repo.name]?.unstaged ?? 0;
    if (unstaged > 0) {
      const ok = await this.dialogs.confirm(
        this.i18n.t('dialog.git.checkout_dirty_title'),
        this.i18n.t('dialog.git.checkout_dirty_msg', {
          count: unstaged,
          name: repo.name,
        }),
      );
      if (!ok) {
        return false;
      }
    }
    const result = await this.commands.git.checkout(repo.path, branch);
    if (!result.ok) {
      await this.dialogs.error(
        this.i18n.t('dialog.git.checkout_error_title'),
        this.i18n.t('dialog.git.checkout_error_msg', {
          branch,
          msg: result.message,
        }),
      );
      return false;
    }
    this.ws.patchCard(repo.name, { branch });
    await this.refreshGitState(repo);
    return true;
  }

  /** Reload branch + branch list + badge, local only (§9 `_reload_repo`). */
  async reload(repo: RepoInfo): Promise<void> {
    await this.loadBranches(repo);
    await this.repos.refreshBadge(repo.path);
  }

  /** Network fetch then branch-list reload (§9 `_fetch_branches`). */
  async fetch(repo: RepoInfo): Promise<void> {
    await this.commands.git.fetch(repo.path);
    await this.refreshGitState(repo);
  }

  /**
   * Load the recency-ordered branch list + current branch into the card
   * state (lazy, on first expand — §7 row 1).
   */
  async loadBranches(repo: RepoInfo): Promise<void> {
    try {
      const [ordered, current] = await Promise.all([
        this.commands.git.branches(repo.path),
        this.commands.git.currentBranch(repo.path),
      ]);
      this.ws.patchCard(
        repo.name,
        {
          branches: ordered.branches,
          recentCount: ordered.recentCount,
          branch: current,
          branchesLoaded: true,
        },
        { silent: true },
      );
    } catch {
      // keep the loading placeholder; badge events still update the branch
    }
  }

  /**
   * Clean flow (§12 "Clean"): confirm, `git clean`, then deselect every env
   * config WITHOUT rewriting files (git already restored the originals) and
   * refresh badges.
   */
  async clean(repo: RepoInfo): Promise<boolean> {
    const ok = await this.dialogs.confirm(
      this.i18n.t('dialog.clean.confirm_title'),
      this.i18n.t('dialog.clean.confirm_msg'),
    );
    if (!ok) {
      return false;
    }
    await this.commands.git.clean(repo.path);
    for (const module of repo.modules) {
      await this.commands.config.setActiveConfig(
        configKeyFor(repo.name, module.key),
        null,
      );
      this.ws.setConfigValue(repo.name, module.key, '');
    }
    await this.refreshGitState(repo);
    return true;
  }

  // -- env configs (§10) --------------------------------------------------------

  /**
   * Apply a saved-environment selection to one module (§10
   * `_on_config_change`): persist the active config, then write the payload
   * through the repo's writer type. `name === ''` deselects (persisted as
   * `null`; the file-restore `git checkout -- <file>` of v1 is Rust-side
   * behavior of `set_active_config` — see integration notes).
   */
  async applyConfigSelection(
    repo: RepoInfo,
    moduleKey: string,
    name: string,
  ): Promise<void> {
    const key = configKeyFor(repo.name, moduleKey);
    this.ws.setConfigValue(repo.name, moduleKey, name);
    try {
      await this.commands.config.setActiveConfig(key, name || null);
      if (!name) {
        return;
      }
      const environments = await this.commands.config.getSavedEnvironments(key);
      const content = environments[name];
      const target = this.envTargetFile(repo, moduleKey);
      if (content === undefined || !target) {
        return;
      }
      await this.commands.config.applyEnvironment({
        writerType: repo.envConfigWriterType,
        targetFile: target,
        profile: name,
        content,
      });
      await this.repos.refreshBadge(repo.path); // file changed → git dirty (§10)
    } catch (err: unknown) {
      // Surface the REAL cause — the generic message alone sent a user
      // chasing uncommitted changes when the actual error was a YAML
      // validation failure (2026-07-03).
      const detail = (err as { message?: string })?.message ?? String(err);
      await this.dialogs.error(
        this.i18n.t('misc.error_title'),
        `${this.i18n.t('dialog.config.write_error', {
          path: this.envTargetFile(repo, moduleKey) ?? key,
        })}\n\n${detail}`,
      );
    }
  }

  /**
   * Drift check (§10 drift deselection): for each module of `repoName` that
   * HAS a selected env, compare the on-disk active file against the saved env
   * content; a mismatch (or a deleted env) deselects that module and records a
   * banner notice. Deselecting does NOT touch the file — the user's edit
   * stays. The deselect is a non-silent patch so the profile dirty-check
   * recomputes (the workspace no longer matches the saved profile).
   *
   * Hooked to the 30 s `git://badge` event (workspace-page); scoped to one
   * repo per call and to modules with a selection, so the per-cycle cost is a
   * handful of small reads.
   */
  async checkEnvDrift(repoName: string): Promise<void> {
    const repo = this.repos.repoByName(repoName);
    if (!repo) {
      return;
    }
    const card = this.ws.card(repo.name);
    const selected = repo.modules
      .map((m) => ({ module: m, name: card.configValues[m.key] ?? '' }))
      .filter((x) => x.name !== '');
    if (selected.length === 0) {
      return;
    }

    const inputs: EnvDriftInput[] = [];
    for (const { module, name } of selected) {
      const target = this.envTargetFile(repo, module.key);
      if (!target) {
        continue;
      }
      const key = configKeyFor(repo.name, module.key);
      const [saved, current] = await Promise.all([
        this.commands.config
          .getSavedEnvironments(key)
          .catch(() => ({}) as Record<string, string>),
        this.commands.config
          .readActiveEnvironment({
            writerType: repo.envConfigWriterType,
            targetFile: target,
            profile: name,
          })
          .catch(() => ''),
      ]);
      inputs.push({
        moduleKey: module.key,
        selectedName: name,
        savedContent: saved[name],
        currentContent: current,
      });
    }

    const drifted = driftedModules(inputs);
    if (drifted.length === 0) {
      return;
    }
    for (const moduleKey of drifted) {
      this.ws.setConfigValue(repo.name, moduleKey, ''); // non-silent → dirty recompute
      await this.commands.config
        .setActiveConfig(configKeyFor(repo.name, moduleKey), null)
        .catch(() => undefined);
    }
    // Append only notices not already shown (a module deselects once, then is
    // skipped next cycle — this dedup guards a re-check racing the same tick).
    const seen = new Set(
      this._driftNotices().map((n) => `${n.repo}::${n.moduleKey}`),
    );
    const fresh = drifted
      .filter((moduleKey) => !seen.has(`${repo.name}::${moduleKey}`))
      .map((moduleKey) => ({ repo: repo.name, moduleKey }));
    if (fresh.length > 0) {
      this._driftNotices.set([...this._driftNotices(), ...fresh]);
    }
  }

  // -- docker (§11) -------------------------------------------------------------

  /** Open the per-file docker dialog is owned by `DialogService` (§19). */
  private async startDocker(repo: RepoInfo): Promise<void> {
    if (!(await this.dockerAvailableGuard())) {
      return;
    }
    const files = this.activeComposeFiles(repo);
    if (files.length === 0) {
      await this.dialogs.warning(
        this.i18n.t('misc.warning_title'),
        this.i18n.t('log.no_compose_files', { name: repo.name }),
      );
      return;
    }
    const state = this.ws.card(repo.name);
    for (const file of files) {
      const services = state.dockerServices[basename(file)];
      await this.commands.docker.composeUp(
        file,
        services && services.length > 0 ? services : undefined,
      );
    }
    this.scheduleDockerRefresh(repo, files);
  }

  private async stopDocker(repo: RepoInfo): Promise<void> {
    const files = this.activeComposeFiles(repo);
    for (const file of files) {
      await this.commands.docker.composeDown(file);
    }
    this.scheduleDockerRefresh(repo, files);
  }

  /**
   * Force status refreshes at 0 / 3000 / 7000 ms to catch slow containers
   * (§28 "Docker post-start polls"); results arrive as `docker://status`.
   */
  private scheduleDockerRefresh(repo: RepoInfo, files: readonly string[]): void {
    const refresh = (): void => {
      for (const file of files) {
        const services = this.ws.composeServices()[file] ?? [];
        void this.commands.docker
          .refreshStatus(repo.name, file, services)
          .catch(() => undefined);
      }
    };
    refresh();
    setTimeout(refresh, 3000);
    setTimeout(refresh, 7000);
  }

  private async dockerAvailableGuard(): Promise<boolean> {
    const available = await this.commands.docker.available().catch(() => false);
    if (!available) {
      await this.dialogs.error(
        this.i18n.t('dialog.docker.unavailable_title'),
        this.i18n.t('dialog.docker.unavailable_msg'),
      );
    }
    return available;
  }

  /** Active compose files resolved to absolute paths; all files when none active (§12). */
  private activeComposeFiles(repo: RepoInfo): readonly string[] {
    const active = this.ws.card(repo.name).dockerActive;
    if (active.length === 0) {
      return repo.dockerComposeFiles;
    }
    const byBase = new Map(repo.dockerComposeFiles.map((f) => [basename(f), f]));
    return active
      .map((a) => byBase.get(basename(a)))
      .filter((f): f is string => f !== undefined);
  }

  // -- profiles (§26) ------------------------------------------------------------

  /**
   * Apply a loaded profile: state first (one dirty check), then — only for an
   * explicit user load (`sideEffects`) — the git checkouts of tracked
   * branches (capped fan-out, §28) and the env-file rewrites of tracked
   * selections. Startup re-apply is state-only, matching v1's collapsed-card
   * no-op semantics (§6 "Collapsed-card semantics").
   */
  async applyProfile(
    doc: ProfileDocument,
    opts?: { sideEffects?: boolean; skipDirtyCheck?: boolean },
  ): Promise<void> {
    this.ws.applyProfileState(doc, { skipDirtyCheck: opts?.skipDirtyCheck ?? false });
    if (!opts?.sideEffects) {
      return;
    }
    const entries = Object.entries(doc.repos)
      .map(([name, rp]) => ({ repo: this.repos.repoByName(name), rp }))
      .filter((e): e is { repo: RepoInfo; rp: (typeof e)['rp'] } => !!e.repo);

    await runBatch(entries, GIT_BATCH_CONCURRENCY, async ({ repo, rp }) => {
      if (rp.branch) {
        const current = await this.commands.git.currentBranch(repo.path).catch(() => '');
        if (current && current !== rp.branch) {
          const result = await this.commands.git.checkout(repo.path, rp.branch);
          if (result.ok) {
            this.ws.patchCard(repo.name, { branch: rp.branch }, { silent: true });
          }
        }
      }
      const firstModule = repo.modules[0];
      if (rp.profile && firstModule) {
        await this.applyConfigSelection(repo, firstModule.key, rp.profile);
      }
    });
    this.ws.scheduleDirtyCheck();
  }

  // -- helpers --------------------------------------------------------------------

  private startOverrides(repo: RepoInfo): { javaLabel?: string } {
    const state = this.ws.card(repo.name);
    const javaLabel =
      repo.features.includes('java_version') && state.javaLabel
        ? state.javaLabel
        : undefined;
    return { javaLabel };
  }

  private envTargetFile(repo: RepoInfo, moduleKey: string): string | undefined {
    const module = repo.modules.find((m) => m.key === moduleKey);
    if (!module) {
      return undefined;
    }
    return (
      module.envFiles.find((f) => basename(f) === repo.envMainConfigFilename) ??
      module.envFiles[0]
    );
  }

  private async refreshGitState(repo: RepoInfo): Promise<void> {
    await this.loadBranches(repo);
    await this.repos.refreshBadge(repo.path).catch(() => undefined);
  }
}

/**
 * Workspace-screen UI state — the v2 home of everything v1 kept on the
 * `RepoCard` widgets and `ProfileManagerMixin` (inventory-gui.md §6-7, §26):
 * per-card selection / expansion / branch cache / env selections / custom
 * command / java pick / docker profile state, plus the 300 ms-debounced
 * profile dirty detection against `ProfilesStore.snapshot`.
 *
 * Containers read per-card state via {@link cardSignal} and mutate it through
 * the setters; every PROFILE-RELEVANT mutation schedules one debounced dirty
 * comparison (§28 `PROFILE_DEBOUNCE_MS`) — the v1 invariant "many triggers
 * per burst → one check". Mutations performed while a profile is being
 * applied are suppressed and collapsed into a single final check
 * (v1 `_applying_profile` flag, §26 — do NOT bypass this).
 */
import { Injectable, Signal, computed, signal } from '@angular/core';

import { IpcCommands } from '../../../core/ipc/commands';
import { IpcEvents } from '../../../core/ipc/events';
import type {
  DockerServiceState,
  DockerStatusEvent,
  ProfileDocument,
  RepoInfo,
  RepoProfile,
  RepoState,
} from '../../../core/ipc/tauri.types';
import { ProfilesStore, normalizeJavaVersion } from '../../../core/state/profiles.store';
import { ReposStore } from '../../../core/state/repos.store';
import { PROFILE_DEBOUNCE_MS } from '../workspace.constants';

/** UI state of one repo card (v1 RepoCard construction state, §6). */
export interface CardState {
  /** Batch-selection checkbox (default checked — §3). */
  readonly selected: boolean;
  /** Manual list position (persisted in `repo_state.order`); `null` = unordered. */
  readonly order: number | null;
  /** Accordion expanded (persisted in `repo_state.expanded`). */
  readonly expanded: boolean;
  /** Current branch (badge events keep it fresh — §9). */
  readonly branch: string;
  /** Recency-ordered branch list; empty until first expand (lazy — §7). */
  readonly branches: readonly string[];
  /** Recents-divider index into {@link branches} (§32 `separator_after`). */
  readonly recentCount: number;
  /** True once `git_branches` resolved at least once. */
  readonly branchesLoaded: boolean;
  /** Branch tracked by the active profile (§7 branch-in-profile checkbox). */
  readonly branchInProfile: boolean;
  /** Selected saved-environment name per module key (`''` = no selection). */
  readonly configValues: Readonly<Record<string, string>>;
  /** Per-module profile tracking (absent key = tracked, v1 default — §7). */
  readonly trackedModules: Readonly<Record<string, boolean>>;
  /** Active command-profile name (`''` = repo default — §7 row 3). */
  readonly selectedCommandProfile: string;
  /** Selected JDK label (`''` = system default sentinel — §7 row 2b). */
  readonly javaLabel: string;
  /** Active compose files (basenames, profile-managed — §11). */
  readonly dockerActive: readonly string[];
  /** Profile-selected services per compose basename (§11). */
  readonly dockerServices: Readonly<Record<string, readonly string[]>>;
}

export const DEFAULT_CARD_STATE: CardState = {
  selected: true,
  order: null,
  expanded: false,
  branch: '',
  branches: [],
  recentCount: 0,
  branchesLoaded: false,
  branchInProfile: false,
  configValues: {},
  trackedModules: {},
  selectedCommandProfile: '',
  javaLabel: '',
  dockerActive: [],
  dockerServices: {},
};

/** Mutation options. */
interface PatchOptions {
  /** Skip the profile dirty-check (UI-only fields like `expanded`). */
  readonly silent?: boolean;
}

/** v1 config-key convention: `"{repo}::{moduleKey}"` (§10, contract §1.5). */
export function configKeyFor(repoName: string, moduleKey: string): string {
  return `${repoName}::${moduleKey}`;
}

/**
 * Build the per-repo profile entry from live card state — the v1
 * `build_profile_data` per-card capture (§26). `profile` carries the FIRST
 * module's selection (the v1 single-string schema, inventory-backend §15.3);
 * `profile_tracked` lists the tracked module keys.
 */
export function buildRepoProfile(repo: RepoInfo, state: CardState): RepoProfile {
  const moduleKeys = repo.modules.map((m) => m.key);
  const firstValue = moduleKeys
    .map((k) => state.configValues[k] ?? '')
    .find((v) => v !== '');
  return {
    git_url: repo.gitRemoteUrl ?? '',
    branch: state.branchInProfile ? state.branch || null : null,
    type: repo.repoType,
    profile: firstValue || null,
    profile_tracked: moduleKeys.filter((k) => state.trackedModules[k] !== false),
    command_profile: state.selectedCommandProfile || null,
    java_version: normalizeJavaVersion(state.javaLabel),
    selected: state.selected,
    docker_compose_active: state.dockerActive,
    docker_profile_services: state.dockerServices,
  };
}

@Injectable({ providedIn: 'root' })
export class WorkspaceStore {
  private readonly _cards = signal<Readonly<Record<string, CardState>>>({});
  private readonly _profileDirty = signal(false);
  /** True after the user explicitly picked the no-profile sentinel (§26). */
  private readonly _noProfile = signal(false);
  private readonly _dockerStatus = signal<
    Readonly<Record<string, Readonly<Record<string, DockerServiceState>>>>
  >({});
  /** compose file path → parsed service names (per-file totals — §11). */
  private readonly _composeServices = signal<Readonly<Record<string, readonly string[]>>>({});
  /** Live repo-list search query (ephemeral — never persisted). */
  private readonly _repoFilter = signal('');
  /** Drag-reorder mode (ephemeral): collapses cards on entry, gates expand. */
  private readonly _reorderMode = signal(false);
  /** repo name → origin workspace group, captured at switch time (session). */
  private readonly _serviceGroups = signal<Readonly<Record<string, string>>>({});

  /** v1 `_applying_profile`: suppress per-mutation dirty checks (§26). */
  private applyingProfile = false;
  private dirtyTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly cardSignals = new Map<string, Signal<CardState>>();

  /** Live profile-dirty flag (drives the topbar `name *` styling — §24/§26). */
  readonly profileDirty = this._profileDirty.asReadonly();

  /** True while the no-profile sentinel is selected. */
  readonly noProfileSelected = this._noProfile.asReadonly();

  /** Latest `docker://status` payloads, keyed by repo name (§11). */
  readonly dockerStatus = this._dockerStatus.asReadonly();

  /** Parsed compose service names per compose file path. */
  readonly composeServices = this._composeServices.asReadonly();

  /** Live repo-list search query (drives the §4 list filter). */
  readonly repoFilter = this._repoFilter.asReadonly();

  /** repo name → origin workspace group (session map, for the orphan banner). */
  readonly serviceGroups = this._serviceGroups.asReadonly();

  setRepoFilter(query: string): void {
    this._repoFilter.set(query);
  }

  /** True while drag-reorder mode is active (gates card expansion). */
  readonly reorderMode = this._reorderMode.asReadonly();

  /**
   * Toggle reorder mode. Entering it collapses EVERY card so the list is a
   * compact set of headers to drag — and `reorderMode` then blocks re-expanding
   * (UI-only; `expanded` is silent so no profile dirty check fires).
   */
  setReorderMode(on: boolean): void {
    this._reorderMode.set(on);
    if (on) {
      this._cards.update((cards) =>
        Object.fromEntries(
          Object.entries(cards).map(([name, card]) => [name, { ...card, expanded: false }]),
        ),
      );
    }
  }

  /**
   * Tag each repo with the workspace group it currently belongs to — called
   * after every scan so a later switch can name where an orphan came from.
   */
  tagServiceGroups(group: string, repoNames: readonly string[]): void {
    this._serviceGroups.update((map) => {
      const next = { ...map };
      for (const name of repoNames) {
        next[name] = group;
      }
      return next;
    });
  }

  /** Persist-shape `repo_state` for one card (shared by card + drag reorder). */
  repoStatePatch(name: string): RepoState {
    const state = this.card(name);
    return {
      selected: state.selected,
      ...(state.selectedCommandProfile ? { command_profile: state.selectedCommandProfile } : {}),
      ...(state.javaLabel ? { java_version: state.javaLabel } : {}),
      expanded: state.expanded,
      ...(state.order !== null ? { order: state.order } : {}),
    };
  }

  /** Set a card's manual list position (UI-only — never marks the profile dirty). */
  setCardOrder(name: string, order: number): void {
    this.patchCard(name, { order }, { silent: true });
  }

  constructor(
    private readonly commands: IpcCommands,
    private readonly events: IpcEvents,
    private readonly repos: ReposStore,
    private readonly profiles: ProfilesStore,
  ) {}

  /** Subscribe docker status events. Called once by the workspace page. */
  async init(): Promise<void> {
    await this.events.onDockerStatus((e) => this.applyDockerStatus(e));
  }

  // -- per-card state ---------------------------------------------------------

  /** Stable reactive view of one card's state (defaults when unknown). */
  cardSignal(name: string): Signal<CardState> {
    let sig = this.cardSignals.get(name);
    if (!sig) {
      sig = computed(() => this._cards()[name] ?? DEFAULT_CARD_STATE);
      this.cardSignals.set(name, sig);
    }
    return sig;
  }

  /** Non-reactive snapshot of one card's state. */
  card(name: string): CardState {
    return this._cards()[name] ?? DEFAULT_CARD_STATE;
  }

  /**
   * Merge a partial card state. Schedules the debounced profile dirty check
   * unless `silent` (or a profile apply is in progress).
   */
  patchCard(name: string, patch: Partial<CardState>, opts?: PatchOptions): void {
    this._cards.update((cards) => ({
      ...cards,
      [name]: { ...(cards[name] ?? DEFAULT_CARD_STATE), ...patch },
    }));
    if (!opts?.silent) {
      this.scheduleDirtyCheck();
    }
  }

  /** Set one module's saved-environment selection (`''` = none). */
  setConfigValue(name: string, moduleKey: string, value: string): void {
    const current = this.card(name);
    this.patchCard(name, {
      configValues: { ...current.configValues, [moduleKey]: value },
    });
  }

  /** Toggle one module's profile tracking checkbox (§7). */
  setModuleTracked(name: string, moduleKey: string, tracked: boolean): void {
    const current = this.card(name);
    this.patchCard(name, {
      trackedModules: { ...current.trackedModules, [moduleKey]: tracked },
    });
  }

  /** Select/deselect every card (GlobalPanel select-all — §3). */
  setAllSelected(names: readonly string[], selected: boolean): void {
    this._cards.update((cards) => {
      const next = { ...cards };
      for (const name of names) {
        next[name] = { ...(next[name] ?? DEFAULT_CARD_STATE), selected };
      }
      return next;
    });
    this.scheduleDirtyCheck();
  }

  /** Names of the currently selected repos, in the given repo order. */
  selectedNames(repoNames: readonly string[]): readonly string[] {
    const cards = this._cards();
    return repoNames.filter((n) => (cards[n] ?? DEFAULT_CARD_STATE).selected);
  }

  /** Drop state of repos that disappeared after a rescan. */
  pruneCards(liveNames: readonly string[]): void {
    const keep = new Set(liveNames);
    this._cards.update((cards) =>
      Object.fromEntries(Object.entries(cards).filter(([n]) => keep.has(n))),
    );
    for (const key of [...this.cardSignals.keys()]) {
      if (!keep.has(key)) {
        this.cardSignals.delete(key);
      }
    }
  }

  // -- profile capture / apply / dirty (§26) ----------------------------------

  /** Capture the whole workspace as a profile document (v1 `build_profile_data`). */
  buildProfileDocument(): ProfileDocument {
    const repos: Record<string, RepoProfile> = {};
    for (const repo of this.repos.repos()) {
      repos[repo.name] = buildRepoProfile(repo, this.card(repo.name));
    }
    return { repos };
  }

  /**
   * Apply a loaded profile document onto the card states (v1 `_apply_config`,
   * §26): raises the applying flag for the duration, then runs exactly ONE
   * dirty check — or none with `skipDirtyCheck` (startup/rebuild, where async
   * branch loads would race a false positive).
   *
   * State only — git checkouts and env-file writes are side effects owned by
   * `RepoActionsService.applyProfile`.
   */
  applyProfileState(doc: ProfileDocument, opts?: { skipDirtyCheck?: boolean }): void {
    this.applyingProfile = true;
    this._noProfile.set(false);
    try {
      for (const [name, rp] of Object.entries(doc.repos)) {
        const repo = this.repos.repoByName(name);
        const current = this.card(name);
        const moduleKeys = repo?.modules.map((m) => m.key) ?? [];
        const configValues: Record<string, string> = { ...current.configValues };
        if (moduleKeys.length > 0) {
          // v1 schema stores a single profile string — applied to the first
          // module; `profile: null` present ⇒ explicitly deselected (§26).
          configValues[moduleKeys[0] as string] = rp.profile ?? '';
        }
        const trackedModules: Record<string, boolean> = {};
        for (const key of moduleKeys) {
          trackedModules[key] = rp.profile_tracked
            ? rp.profile_tracked.includes(key)
            : true; // legacy profiles without the list ⇒ all tracked (§26)
        }
        this.patchCard(
          name,
          {
            selected: rp.selected,
            branchInProfile: rp.branch !== null,
            ...(rp.branch !== null ? { branch: rp.branch } : {}),
            configValues,
            trackedModules,
            selectedCommandProfile: rp.command_profile ?? '',
            javaLabel: normalizeJavaVersion(rp.java_version) ?? '',
            dockerActive: rp.docker_compose_active ?? [],
            dockerServices: rp.docker_profile_services ?? {},
          },
          { silent: true },
        );
      }
    } finally {
      this.applyingProfile = false;
    }
    if (!opts?.skipDirtyCheck) {
      this.runDirtyCheck();
    } else {
      this._profileDirty.set(false);
    }
  }

  /**
   * User picked the no-profile sentinel: nothing to be dirty against (§26).
   * Also resets every card's env-config selection to the no-selection
   * sentinel (`''`) — the v1 sentinel pick deselected all env combos. State
   * only (silent): no env files are rewritten and no dirty check runs.
   */
  clearActiveProfile(): void {
    this._noProfile.set(true);
    this._cards.update((cards) =>
      Object.fromEntries(
        Object.entries(cards).map(([name, card]) => [
          name,
          {
            ...card,
            configValues: Object.fromEntries(
              Object.keys(card.configValues).map((key) => [key, '']),
            ),
          },
        ]),
      ),
    );
    this._profileDirty.set(false);
  }

  /**
   * Debounced dirty comparison (§28 `PROFILE_DEBOUNCE_MS` = 300 ms). Card
   * containers MUST mutate through this store so bursts collapse into one
   * comparison — never call the comparison directly from card code
   * (v1 `_check_profile_changes` contract).
   */
  scheduleDirtyCheck(): void {
    if (this.applyingProfile) {
      return;
    }
    clearTimeout(this.dirtyTimer);
    this.dirtyTimer = setTimeout(() => this.runDirtyCheck(), PROFILE_DEBOUNCE_MS);
  }

  private runDirtyCheck(): void {
    if (this._noProfile()) {
      this._profileDirty.set(false);
      return;
    }
    this._profileDirty.set(this.profiles.isDirtyAgainst(this.buildProfileDocument()));
  }

  // -- docker status (§11) -----------------------------------------------------

  /**
   * Parse (and cache) the service names of every compose file of a repo —
   * the per-file `total` of the `[running/total]` button counter. Triggered
   * on first card expand (v1 prefetch, §7).
   */
  async prefetchComposeServices(repo: RepoInfo): Promise<void> {
    const cache = this._composeServices();
    await Promise.all(
      repo.dockerComposeFiles
        .filter((file) => cache[file] === undefined)
        .map(async (file) => {
          try {
            const services = await this.commands.docker.composeServices(file);
            this._composeServices.update((c) => ({
              ...c,
              [file]: services.map((s) => s.name),
            }));
          } catch {
            // compose parse failure: leave the [?/?] placeholder counts
          }
        }),
    );
  }

  /**
   * `[running/total]` counts of one compose file. `null` until both the
   * compose parse and the first `docker://status` event arrived (renders as
   * `[?/?]` — §7 row 3.5).
   */
  composeCounts(
    repoName: string,
    composeFile: string,
  ): { running: number; total: number } | null {
    const names = this._composeServices()[composeFile];
    if (!names) {
      return null;
    }
    const status = this._dockerStatus()[repoName];
    if (!status) {
      return null;
    }
    const running = names.filter((n) => status[n] === 'running').length;
    return { running, total: names.length };
  }

  private applyDockerStatus(event: DockerStatusEvent): void {
    this._dockerStatus.update((all) => ({ ...all, [event.name]: event.services }));
  }
}

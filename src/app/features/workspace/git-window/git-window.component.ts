/**
 * Detached git window (git suite, design doc
 * docs/superpowers/specs/2026-07-02-git-suite-design.md — phase 3 rework).
 *
 * Rendered INSTEAD of the workspace page when the SPA is loaded with
 * `?git=<repoId>`; created Rust-side by `open_git_window`. The MODE is fixed
 * at open time by the URL (user decision 2026-07-02: history and stashes are
 * different things — no tabs):
 *
 * - default → HISTORY: filters + lane graph list. Selecting a commit
 *   replaces the list with the full-window detail (breadcrumb + shared
 *   files/diff panel + "view on web" when the remote is browsable). A
 *   Compare view (base…target: incoming commits list + range diff) hangs
 *   off the toolbar; its commits open the same detail with back-to-compare.
 * - `&tab=stashes` → STASHES: stash list; selecting one (or opening with
 *   `&stash=<n>`) shows the SAME full-window files+code detail with a back
 *   button returning to the stash list. Same behavior as history, separate
 *   surface.
 * - `&tab=changes` → CHANGES: working-tree changes with stage/unstage/
 *   discard/edit (changes-badge entry) — fully owned by the embedded
 *   `git-changes-view` container (design doc 2026-07-03).
 */
import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';

import { TranslationService } from '../../../core/i18n/translation.service';
import { TPipe } from '../../../core/i18n/t.pipe';
import { IpcCommands } from '../../../core/ipc/commands';
import type {
  GitAuthor,
  GitCommitFileStat,
  GitCommitInfo,
  StashEntry,
} from '../../../core/ipc/tauri.types';
import {
  AvatarComponent,
  BadgeComponent,
  ButtonComponent,
  ContextMenuService,
  IconComponent,
  SearchableSelectComponent,
  SpinnerComponent,
  type MenuEntry,
} from '../../../ui';
import { IpcEvents } from '../../../core/ipc/events';
import { TauriBridge } from '../../../core/ipc/tauri-bridge';
import { openDialogWindowForResult } from '../../dialogs/dialog-window.bridge';
import { OpenerService } from '../opener.service';
import { ChangesViewComponent } from './changes-view.component';
import { commitWebUrl } from './commit-web-url';
import { FileDiffPanelComponent, type FileDiffPanelText } from './file-diff-panel.component';
import { GraphCellComponent } from './graph-cell.component';
import { assignBranchColors, computeGraph, graphWidth, laneColor, type GraphRow } from './graph';
import {
  EMPTY_FILTERS,
  authorLabel,
  buildLogFilter,
  emailOfLabel,
  formatCommitDate,
  formatRelativeDate,
  shortSha,
  type FilterFormState,
} from './git-window.logic';

type DetailMode = 'diff' | 'file';
type View = 'list' | 'compare' | 'detail';
/** Where the detail was opened from — the back button's target. */
type DetailOrigin = 'list' | 'compare' | 'stashes';
/** What the shared panel diffs against: one ref or a base…target range. */
type PanelSource = 'ref' | 'range';

@Component({
  selector: 'git-window',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    BadgeComponent,
    ButtonComponent,
    ChangesViewComponent,
    FileDiffPanelComponent,
    GraphCellComponent,
    IconComponent,
    NgTemplateOutlet,
    SearchableSelectComponent,
    SpinnerComponent,
    TPipe,
  ],
  styleUrl: './git-window.component.scss',
  template: `
    @if (mode === 'history' && view() === 'list') {
      <header class="gitwin__top">
        <div class="gitwin__filters">
          <ui-searchable-select
            class="gitwin__select"
            [options]="branchOptions()"
            [recentCount]="recentBranchCount()"
            [value]="branchValue()"
            [searchPlaceholder]="'placeholder.search' | t"
            [noResultsText]="'placeholder.no_results' | t"
            (selectionChange)="onBranchSelected($event)"
          />
          <ui-searchable-select
            class="gitwin__select gitwin__select--author"
            [options]="authorOptions()"
            [value]="authorValue()"
            [searchPlaceholder]="'placeholder.search' | t"
            [noResultsText]="'placeholder.no_results' | t"
            (selectionChange)="onAuthorSelected($event)"
          />
          <input
            class="gitwin__input gitwin__input--grow"
            type="text"
            [placeholder]="'git.filter_text' | t"
            [value]="filters().text"
            (change)="onFilter('text', $any($event.target).value)"
          />
        </div>
        <div class="gitwin__filters">
          <ui-searchable-select
            class="gitwin__select gitwin__select--path"
            [options]="pathSelectOptions()"
            [value]="pathValue()"
            [searchPlaceholder]="'git.filter_path' | t"
            [noResultsText]="'placeholder.no_results' | t"
            (selectionChange)="onPathSelected($event)"
          />
          <input
            class="gitwin__input gitwin__input--date"
            type="date"
            [title]="'git.filter_since' | t"
            [value]="filters().since"
            (change)="onFilter('since', $any($event.target).value)"
          />
          <input
            class="gitwin__input gitwin__input--date"
            type="date"
            [title]="'git.filter_until' | t"
            [value]="filters().until"
            (change)="onFilter('until', $any($event.target).value)"
          />
          <ui-button variant="log-action" size="sm" (clicked)="onClearFilters()">
            {{ 'git.filter_clear' | t }}
          </ui-button>
          <ui-button variant="purple-alt" size="sm" (clicked)="openCompare()">
            <ui-icon name="git-branch" [size]="14" /> {{ 'git.compare' | t }}
          </ui-button>
        </div>
      </header>
    }

    @if (error()) {
      <div class="gitwin__error">
        <ui-icon name="alert-triangle" [size]="14" /> {{ error() }}
      </div>
    }

    @switch (view()) {
      @case ('list') {
        @if (mode === 'history') {
          <section class="gitwin__surface gitwin__commits">
            @if (loading() && commits().length === 0) {
              <div class="gitwin__center"><ui-spinner /></div>
            } @else if (commits().length === 0) {
              <div class="gitwin__center gitwin__muted">{{ 'git.no_commits' | t }}</div>
            } @else {
              <ul class="gitwin__list">
                @for (commit of commits(); track commit.sha; let i = $index) {
                  <li
                    class="gitwin__commit"
                    (click)="onSelectCommit(commit, 'list')"
                    (contextmenu)="onCommitMenu($event, commit, i)"
                  >
                    <git-graph-cell
                      [row]="graphRows()[i]"
                      [lanes]="graphLanes()"
                      [palette]="branchPalette()"
                      (laneClicked)="onFilter('branch', $event)"
                      (dotClicked)="onDotClicked(commit, i)"
                    />
                    <ui-avatar
                      [email]="commit.authorEmail"
                      [name]="commit.authorName"
                      [size]="24"
                    />
                    <div class="gitwin__commit-main">
                      <div class="gitwin__commit-line1">
                        <span class="gitwin__subject" [title]="commit.subject">{{
                          commit.subject
                        }}</span>
                        @for (ref of commit.refs; track ref) {
                          <span
                            class="gitwin__ref"
                            (click)="onRefClicked(ref, $event)"
                          >
                            <ui-badge tone="solid" [bg]="laneColorAt(i)" [mono]="true">{{
                              ref
                            }}</ui-badge>
                          </span>
                        }
                      </div>
                      <div class="gitwin__meta">
                        <span class="gitwin__mono" [title]="commit.sha">{{
                          short(commit.sha)
                        }}</span>
                        <span>{{ commit.authorName }}</span>
                        <span [title]="date(commit.date)">{{ relDate(commit.date) }}</span>
                        @if (commit.parents.length > 1) {
                          <ui-badge tone="muted">{{ 'git.merge_commit' | t }}</ui-badge>
                        }
                        <!-- Lane's branch name for undecorated commits (tips
                             already show their ref chips on line 1). -->
                        @if (commit.refs.length === 0 && graphRows()[i].label; as laneLabel) {
                          <span class="gitwin__lane-label" [style.color]="laneColorAt(i)">
                            {{ laneLabel }}
                          </span>
                        }
                      </div>
                    </div>
                  </li>
                }
              </ul>
              @if (hasMore()) {
                <div class="gitwin__more">
                  <ui-button
                    variant="log-action"
                    size="sm"
                    [disabled]="loading()"
                    (clicked)="onLoadMore()"
                  >
                    {{ 'git.load_more' | t }}
                  </ui-button>
                </div>
              }
            }
          </section>
        } @else if (mode === 'stashes') {
          <section class="gitwin__surface gitwin__commits">
            @if (stashes().length === 0) {
              <div class="gitwin__center gitwin__muted">{{ 'git.no_stashes' | t }}</div>
            } @else {
              <ul class="gitwin__list">
                @for (stash of stashes(); track stash.index) {
                  <li
                    class="gitwin__commit gitwin__stash"
                    (click)="onSelectStash(stash)"
                    (contextmenu)="onStashMenu($event, stash)"
                  >
                    <span class="gitwin__mono gitwin__stash-ref"
                      >stash&#64;{{ '{' }}{{ stash.index }}{{ '}' }}</span
                    >
                    <span class="gitwin__subject" [title]="stash.message">{{
                      stash.message
                    }}</span>
                    @if (stash.branch) {
                      <ui-badge tone="muted" [mono]="true">{{ stash.branch }}</ui-badge>
                    }
                  </li>
                }
              </ul>
            }
          </section>
        } @else if (repoPath()) {
          <git-changes-view [repoPath]="repoPath()" />
        }
      }
      @case ('compare') {
        <div class="gitwin__crumb">
          <ui-button variant="log-action" size="sm" (clicked)="closeCompare()">
            ← {{ 'git.back' | t }}
          </ui-button>
          <ui-searchable-select
            class="gitwin__select"
            [options]="compareBranchOptions()"
            [value]="compareBase()"
            [searchPlaceholder]="'placeholder.search' | t"
            [noResultsText]="'placeholder.no_results' | t"
            (selectionChange)="onCompareBase($event)"
          />
          <span class="gitwin__muted">…</span>
          <ui-searchable-select
            class="gitwin__select"
            [options]="compareBranchOptions()"
            [value]="compareTarget()"
            [searchPlaceholder]="'placeholder.search' | t"
            [noResultsText]="'placeholder.no_results' | t"
            (selectionChange)="onCompareTarget($event)"
          />
          <ui-button variant="log-action" size="sm" (clicked)="onSwapCompare()">
            <ui-icon name="refresh" [size]="14" /> {{ 'git.swap' | t }}
          </ui-button>
          <span class="gitwin__muted gitwin__compare-hint">{{
            'git.compare_hint' | t: { count: compareCommits().length.toString() }
          }}</span>
        </div>
        <div class="gitwin__compare-body">
          <aside class="gitwin__surface gitwin__compare-commits">
            @if (compareLoading()) {
              <div class="gitwin__center"><ui-spinner /></div>
            } @else if (compareCommits().length === 0) {
              <div class="gitwin__center gitwin__muted">{{ 'git.no_commits' | t }}</div>
            } @else {
              <ul class="gitwin__list">
                @for (commit of compareCommits(); track commit.sha) {
                  <li
                    class="gitwin__commit"
                    (click)="onSelectCommit(commit, 'compare')"
                    (contextmenu)="onCommitMenu($event, commit, -1)"
                  >
                    <ui-avatar
                      [email]="commit.authorEmail"
                      [name]="commit.authorName"
                      [size]="24"
                    />
                    <div class="gitwin__commit-main">
                      <div class="gitwin__commit-line1">
                        <span class="gitwin__subject" [title]="commit.subject">{{
                          commit.subject
                        }}</span>
                      </div>
                      <div class="gitwin__meta">
                        <span class="gitwin__mono">{{ short(commit.sha) }}</span>
                        <span>{{ commit.authorName }}</span>
                      </div>
                    </div>
                  </li>
                }
              </ul>
            }
          </aside>
          <ng-container [ngTemplateOutlet]="diffPanel" />
        </div>
      }
      @case ('detail') {
        <!-- Stash mode has NO breadcrumb (user 2026-07-03: just the files) —
             each stash opens its own window straight into this detail. -->
        @if (mode === 'history') {
          <div class="gitwin__crumb">
            <ui-button variant="log-action" size="sm" (clicked)="onBack()">
              ← {{ 'git.back' | t }}
            </ui-button>
            @if (detailCommit(); as commit) {
              <ui-avatar [email]="commit.authorEmail" [name]="commit.authorName" [size]="26" />
              <span class="gitwin__subject gitwin__crumb-subject" [title]="commit.subject">{{
                commit.subject
              }}</span>
              <span class="gitwin__meta">
                <span class="gitwin__mono">{{ short(commit.sha) }}</span>
                <span>{{ commit.authorName }}</span>
                <span>{{ date(commit.date) }}</span>
              </span>
              <span class="gitwin__spacer"></span>
              <ui-button variant="log-action" size="sm" (clicked)="onCopySha()">
                <ui-icon name="copy" [size]="14" /> {{ 'git.copy_sha' | t }}
              </ui-button>
              @if (webUrl()) {
                <ui-button variant="log-action" size="sm" (clicked)="onOpenWeb()">
                  <ui-icon name="external-link" [size]="14" /> {{ 'git.view_web' | t }}
                </ui-button>
              }
            }
          </div>
          @if (detailBody()) {
            <div class="gitwin__body-msg">{{ detailBody() }}</div>
          }
        }
        <ng-container [ngTemplateOutlet]="diffPanel" />
      }
    }

    <!-- Shared files/diff panel — one binding site for the compare and
         detail views (identical inputs; the surrounding layout differs). -->
    <ng-template #diffPanel>
      <git-file-diff-panel
        class="gitwin__panel"
        [files]="files()"
        [selectedPath]="selectedFile()"
        [mode]="detailMode()"
        [diffText]="diffText()"
        [fileText]="fileText()"
        [notice]="notice()"
        [loading]="detailLoading()"
        [showFileHistory]="mode === 'history'"
        [filterQuery]="fileFilter()"
        [text]="panelText()"
        (filterChanged)="fileFilter.set($event)"
        (fileSelected)="onSelectFile($event)"
        (viewFile)="onViewFile()"
        (backToDiff)="onBackToDiff()"
        (fileHistory)="onFileHistory($event)"
        (fileMenuRequested)="onFileMenu($event.event, $event.file)"
      />
    </ng-template>
  `,
})
export class GitWindowComponent implements OnInit {
  protected readonly i18n = inject(TranslationService);
  private readonly commands = inject(IpcCommands);
  private readonly opener = inject(OpenerService);
  private readonly menu = inject(ContextMenuService);
  private readonly events = inject(IpcEvents);
  private readonly bridge = inject(TauriBridge);

  /** Repo id from `?git=` — the repo NAME (repo-card passes `repo.name`). */
  private readonly repoId = signal('');
  protected readonly repoPath = signal('');
  private readonly remoteUrl = signal('');

  /** Window mode, fixed at open time by the URL (`&tab=stashes|changes`). */
  protected mode: 'history' | 'stashes' | 'changes' = 'history';
  protected readonly view = signal<View>('list');
  private detailOrigin: DetailOrigin = 'list';

  // -- filters (history list) --------------------------------------------------
  protected readonly filters = signal<FilterFormState>(EMPTY_FILTERS);
  private readonly branches = signal<readonly string[]>([]);
  private readonly tags = signal<readonly string[]>([]);
  private readonly recentCount = signal(0);
  private readonly authors = signal<readonly GitAuthor[]>([]);
  private readonly currentBranch = signal('');
  /** Tracked files (capped Rust-side) — the path filter's autocomplete. */
  protected readonly pathOptions = signal<readonly string[]>([]);
  protected readonly pathSelectOptions = computed(() => [
    this.i18n.t('git.all_paths'),
    ...this.pathOptions(),
  ]);
  protected readonly pathValue = computed(
    () => this.filters().path || this.i18n.t('git.all_paths'),
  );

  protected readonly branchOptions = computed(() => [
    this.i18n.t('git.all_branches'),
    ...this.branches(),
    // Tags carry git's own decoration prefix so they never read as branches.
    ...this.tags().map((t) => `tag: ${t}`),
  ]);
  protected readonly recentBranchCount = computed(() => this.recentCount() + 1);
  protected readonly branchValue = computed(() => {
    const branch = this.filters().branch;
    if (!branch) {
      return this.i18n.t('git.all_branches');
    }
    // A tag rev displays as `tag: X` — clicking a tag chip/dot sets the
    // bare name, but it must not read as a branch (user 2026-07-04).
    return this.tags().includes(branch) ? `tag: ${branch}` : branch;
  });
  protected readonly authorOptions = computed(() => [
    this.i18n.t('git.all_authors'),
    ...this.authors().map((a) => authorLabel(a.name, a.email)),
  ]);
  protected readonly authorValue = computed(() => {
    const email = this.filters().author;
    const match = this.authors().find((a) => a.email === email);
    return match ? authorLabel(match.name, match.email) : this.i18n.t('git.all_authors');
  });

  /** Page palette: distinct visible labels → colors, first-seen order. */
  protected readonly branchPalette = computed(() => assignBranchColors(this.graphRows()));

  // -- history list --------------------------------------------------------------
  protected readonly commits = signal<readonly GitCommitInfo[]>([]);
  protected readonly hasMore = signal(false);
  protected readonly loading = signal(false);
  protected readonly error = signal('');

  /** Non-branch filters fragment topology — collapse to the linear graph. */
  private readonly fragmented = computed(() => {
    const f = this.filters();
    return !!(f.author || f.text || f.path || f.since || f.until);
  });

  protected readonly graphRows = computed<readonly GraphRow[]>(() =>
    computeGraph(this.commits(), { linear: this.fragmented() }),
  );
  protected readonly graphLanes = computed(() => graphWidth(this.graphRows()));

  // -- compare -------------------------------------------------------------------
  protected readonly compareBase = signal('');
  protected readonly compareTarget = signal('');
  protected readonly compareCommits = signal<readonly GitCommitInfo[]>([]);
  protected readonly compareLoading = signal(false);
  /**
   * The branch list strips `origin/` from remote-only branches (v1 checkout
   * convenience), so offer both forms here — the backend resolves either
   * side to `origin/<rev>` when it only exists remotely.
   */
  protected readonly compareBranchOptions = computed(() => [
    ...this.branches(),
    ...this.branches().map((b) => `origin/${b}`),
  ]);

  // -- stashes --------------------------------------------------------------------
  protected readonly stashes = signal<readonly StashEntry[]>([]);

  // -- shared detail panel ----------------------------------------------------------
  protected readonly files = signal<readonly GitCommitFileStat[]>([]);
  /**
   * File-list search of the shared panel. NOT cleared by `resetDetail` —
   * opening a commit from a path-filtered history PRE-FILLS it (user
   * 2026-07-15: "accedo a un commit → primero los ficheros que busqué"),
   * so each entry point sets it explicitly.
   */
  protected readonly fileFilter = signal('');
  protected readonly selectedFile = signal('');
  protected readonly detailMode = signal<DetailMode>('diff');
  protected readonly detailLoading = signal(false);
  protected readonly diffText = signal('');
  protected readonly fileText = signal('');
  protected readonly notice = signal('');

  /** Commit shown in the detail breadcrumb (null when it is a stash). */
  protected readonly detailCommit = signal<GitCommitInfo | null>(null);
  /** Full commit message body (subject stripped), fetched on demand. */
  protected readonly detailBody = signal('');
  protected readonly webUrl = computed(() =>
    commitWebUrl(this.remoteUrl(), this.detailCommit()?.sha ?? ''),
  );

  protected readonly panelText = computed<FileDiffPanelText>(() => ({
    selectFile: this.i18n.t('git.select_file'),
    viewFile: this.i18n.t('git.view_file'),
    backToDiff: this.i18n.t('git.back_to_diff'),
    binaryBadge: this.i18n.t('git.binary'),
    emptyDiff: this.i18n.t('git.empty_diff'),
    fileHistory: this.i18n.t('git.file_history'),
    filterFiles: this.i18n.t('git.filter_files'),
  }));

  /** What the panel queries: a ref (commit / `stash@{n}`) or a range. */
  private panelSource: PanelSource = 'ref';
  private detailRef = '';

  async ngOnInit(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('git') ?? '';
    this.repoId.set(id);
    const tab = params.get('tab');
    this.mode = tab === 'stashes' ? 'stashes' : tab === 'changes' ? 'changes' : 'history';
    const titleKey = {
      history: 'git.title_history',
      stashes: 'git.title_stashes',
      changes: 'git.title_changes',
    }[this.mode];
    document.title = `${id} — ${this.i18n.t(titleKey)}`;

    const presetBranch = params.get('branch') ?? '';
    if (presetBranch) {
      this.filters.update((f) => ({ ...f, branch: presetBranch }));
    }

    try {
      const repos = await this.commands.detection.listRepos();
      const repo = repos.find((r) => r.name === id);
      if (!repo) {
        this.error.set(this.i18n.t('git.repo_not_found', { name: id }));
        return;
      }
      this.repoPath.set(repo.path);
      this.remoteUrl.set(repo.gitRemoteUrl ?? '');
    } catch (err: unknown) {
      this.error.set(this.messageOf(err));
      return;
    }

    if (this.mode === 'changes') {
      return; // the embedded changes view owns its own loading
    }

    if (this.mode === 'stashes') {
      await this.loadStashes();
      const preset = Number(params.get('stash') ?? NaN);
      const stash =
        this.stashes().find((s) => s.index === preset) ??
        (Number.isNaN(preset) ? undefined : this.stashes()[0]);
      if (stash) {
        void this.onSelectStash(stash);
      }
      return;
    }

    void this.loadBranches();
    void this.loadTags();
    void this.loadAuthors();
    void this.commands.git
      .currentBranch(this.repoPath())
      .then((b) => this.currentBranch.set(b))
      .catch(() => undefined);
    void this.commands.git
      .lsFiles(this.repoPath())
      .then((files) => this.pathOptions.set(files))
      .catch(() => undefined); // autocomplete is a convenience
    await this.reload();
  }

  // -- filters ---------------------------------------------------------------

  protected onFilter(key: keyof FilterFormState, value: string): void {
    this.filters.update((f) => ({ ...f, [key]: value }));
    void this.reload();
  }

  protected onBranchSelected(value: string): void {
    const branch =
      value === this.i18n.t('git.all_branches') ? '' : value.replace(/^tag: /, '');
    this.onFilter('branch', branch);
  }

  protected onAuthorSelected(value: string): void {
    this.onFilter('author', emailOfLabel(value));
  }

  protected onPathSelected(value: string): void {
    this.onFilter('path', value === this.i18n.t('git.all_paths') ? '' : value);
  }

  /** Ref chip click: scope the history to that ref (tags are refs too —
   *  always filterable; only DELETED merge-subject names are not). */
  protected onRefClicked(ref: string, event: Event): void {
    event.stopPropagation();
    const rev = ref.replace(/^HEAD -> /, '').replace(/^tag: /, '');
    this.onFilter('branch', rev);
  }

  protected onClearFilters(): void {
    this.filters.set(EMPTY_FILTERS);
    void this.reload();
  }

  // -- history list -------------------------------------------------------------

  protected onLoadMore(): void {
    void this.fetchPage(this.commits().length);
  }

  protected onSelectCommit(commit: GitCommitInfo, origin: DetailOrigin): void {
    this.detailOrigin = origin;
    this.detailCommit.set(commit);
    this.view.set('detail');
    void this.openDetail(commit.sha, 'ref');
    // A path-filtered history carries the search into the file list: the
    // files the user was hunting sort first in the commit detail. Compare
    // origin keeps whatever was typed in the compare panel instead.
    if (origin === 'list') {
      this.fileFilter.set(this.filters().path);
    }
    // Body arrives async; strip the subject line (the crumb already shows it).
    this.detailBody.set('');
    void this.commands.git
      .commitBody(this.repoPath(), commit.sha)
      .then((full) => {
        const body = full.startsWith(commit.subject)
          ? full.slice(commit.subject.length).trim()
          : full.trim();
        this.detailBody.set(body);
      })
      .catch(() => undefined); // body is a nice-to-have
  }

  protected onBack(): void {
    if (this.detailOrigin === 'compare') {
      this.view.set('compare');
      // Restore the range contents the compare view was showing.
      void this.openRange();
    } else {
      this.view.set('list');
      this.resetDetail();
    }
    this.detailCommit.set(null);
  }

  // -- compare ---------------------------------------------------------------------

  protected openCompare(): void {
    if (this.compareBase() === '') {
      // Incoming-changes preset: local branch vs its remote counterpart.
      // The backend verifies the revs, so a missing remote surfaces as a
      // clear git error instead of a silent empty view.
      const current = this.currentBranch();
      this.compareBase.set(current);
      this.compareTarget.set(current ? `origin/${current}` : '');
    }
    this.view.set('compare');
    void this.openRange();
  }

  protected closeCompare(): void {
    this.view.set('list');
    this.resetDetail();
  }

  protected onCompareBase(value: string): void {
    this.compareBase.set(value);
    void this.openRange();
  }

  protected onCompareTarget(value: string): void {
    this.compareTarget.set(value);
    void this.openRange();
  }

  protected onSwapCompare(): void {
    const base = this.compareBase();
    this.compareBase.set(this.compareTarget());
    this.compareTarget.set(base);
    void this.openRange();
  }

  /** (Re)load the compare view: incoming commits + range file list. */
  private async openRange(): Promise<void> {
    const base = this.compareBase();
    const target = this.compareTarget();
    this.resetDetail();
    this.compareCommits.set([]);
    if (base === '' || target === '' || base === target) {
      return;
    }
    this.compareLoading.set(true);
    this.error.set('');
    try {
      const [page, rangeFiles] = await Promise.all([
        this.commands.git.log(this.repoPath(), { branch: `${base}..${target}`, skip: 0 }),
        this.commands.git.diffRange(this.repoPath(), base, target),
      ]);
      this.compareCommits.set(page.commits);
      this.panelSource = 'range';
      this.files.set(rangeFiles);
    } catch (err: unknown) {
      this.error.set(this.messageOf(err));
    } finally {
      this.compareLoading.set(false);
    }
  }

  // -- stashes ------------------------------------------------------------------

  protected onSelectStash(stash: StashEntry): void {
    this.detailOrigin = 'stashes';
    this.detailCommit.set(null);
    this.view.set('detail');
    void this.openDetail(`stash@{${stash.index}}`, 'ref');
    this.fileFilter.set('');
  }

  // -- shared detail panel -------------------------------------------------------

  protected async onSelectFile(file: GitCommitFileStat): Promise<void> {
    this.selectedFile.set(file.path);
    this.detailMode.set('diff');
    await this.loadDiff(file);
  }

  protected async onViewFile(): Promise<void> {
    this.detailMode.set('file');
    this.notice.set('');
    this.detailLoading.set(true);
    // Range mode shows the file as it stands on the TARGET side.
    const ref = this.panelSource === 'range' ? this.compareTarget() : this.detailRef;
    try {
      const result = await this.commands.git.fileAtCommit(
        this.repoPath(),
        ref,
        this.selectedFile(),
      );
      if (result.binary) {
        this.notice.set(this.i18n.t('git.binary_file'));
      } else if (result.tooLarge) {
        this.notice.set(this.i18n.t('git.too_large', { size: String(result.size) }));
      } else {
        this.fileText.set(result.content ?? '');
      }
    } catch (err: unknown) {
      this.error.set(this.messageOf(err));
    } finally {
      this.detailLoading.set(false);
    }
  }

  protected onBackToDiff(): void {
    this.detailMode.set('diff');
    this.notice.set('');
    const file = this.files().find((f) => f.path === this.selectedFile());
    if (file) {
      void this.loadDiff(file);
    }
  }

  protected onOpenWeb(): void {
    const url = this.webUrl();
    if (url) {
      void this.opener.openUrl(url);
    }
  }

  /**
   * Dot click: live branch name filters by name; a DELETED branch's line is
   * still walkable from the commit itself — filter by its sha (shows that
   * branch's full chain, user 2026-07-04 "quiero acceder a la rama").
   */
  protected onDotClicked(commit: GitCommitInfo, i: number): void {
    const row = this.graphRows()[i];
    const rev = row?.labelLive && row.label ? row.label : commit.sha;
    this.onFilter('branch', rev);
  }

  /** "File history" from the detail panel: scope the log to that path. */
  protected onFileHistory(path: string): void {
    this.detailCommit.set(null);
    this.view.set('list');
    this.onFilter('path', path);
  }

  protected onCopySha(): void {
    const sha = this.detailCommit()?.sha;
    if (sha) {
      void navigator.clipboard.writeText(sha);
    }
  }

  // -- context menus ---------------------------------------------------------------

  /** Right-click on a file row of the shared files/diff panel. */
  protected async onFileMenu(event: MouseEvent, file: GitCommitFileStat): Promise<void> {
    const t = (key: string): string => this.i18n.t(key);
    const items: MenuEntry[] = [
      { id: 'view', label: t('git.view_file'), icon: 'file-text', disabled: file.binary },
      ...(this.mode === 'history'
        ? [{ id: 'history', label: t('git.file_history'), icon: 'history' } as const]
        : []),
      { id: 'copy-path', label: t('menu.copy_path'), icon: 'copy', separator: true },
    ];

    switch (await this.menu.openFromEvent(event, items)) {
      case 'view':
        await this.onSelectFile(file);
        return this.onViewFile();
      case 'history':
        return this.onFileHistory(file.path);
      case 'copy-path':
        return void navigator.clipboard.writeText(file.path).catch(() => undefined);
    }
  }

  /**
   * Right-click on a commit row (history list `i >= 0`, compare list `-1`).
   * Copy actions were detail-only before — this makes them one right-click.
   */
  protected async onCommitMenu(
    event: MouseEvent,
    commit: GitCommitInfo,
    i: number,
  ): Promise<void> {
    const t = (key: string): string => this.i18n.t(key);
    const web = commitWebUrl(this.remoteUrl(), commit.sha);
    const row = i >= 0 ? this.graphRows()[i] : undefined;
    const branch = row?.label ?? '';
    const items: MenuEntry[] = [
      { id: 'copy-sha', label: t('git.copy_sha'), icon: 'copy', hint: this.short(commit.sha) },
      { id: 'copy-subject', label: t('menu.copy_subject'), icon: 'copy' },
      ...(branch
        ? [{ id: 'copy-branch', label: t('menu.copy_branch'), icon: 'git-branch', hint: branch } as const]
        : []),
      { id: 'web', label: t('git.view_web'), icon: 'external-link', disabled: !web, separator: true },
      ...(this.mode === 'history' && i >= 0
        ? [{ id: 'compare', label: t('menu.compare_from_here'), icon: 'git-merge' } as const]
        : []),
    ];

    switch (await this.menu.openFromEvent(event, items)) {
      case 'copy-sha':
        return void navigator.clipboard.writeText(commit.sha).catch(() => undefined);
      case 'copy-subject':
        return void navigator.clipboard.writeText(commit.subject).catch(() => undefined);
      case 'copy-branch':
        return void navigator.clipboard.writeText(branch).catch(() => undefined);
      case 'web':
        if (web) void this.opener.openUrl(web);
        return;
      case 'compare':
        this.compareBase.set(this.short(commit.sha));
        this.compareTarget.set(this.currentBranch() || 'HEAD');
        this.view.set('compare');
        return void this.openRange();
    }
  }

  /**
   * Right-click on a stash row — apply/pop/drop parity with the stash dialog
   * (the window was view-only before; commands existed but had no surface).
   */
  protected async onStashMenu(event: MouseEvent, stash: StashEntry): Promise<void> {
    const t = (key: string): string => this.i18n.t(key);
    const items: MenuEntry[] = [
      { id: 'apply', label: t('dialog.stash.btn_apply'), icon: 'check' },
      { id: 'pop', label: t('dialog.stash.btn_pop'), icon: 'upload' },
      { id: 'drop', label: t('dialog.stash.btn_drop'), icon: 'trash', danger: true, separator: true },
    ];
    const picked = await this.menu.openFromEvent(event, items);
    if (!picked) {
      return;
    }
    if (picked === 'drop') {
      // Confirm as a child window parented to THIS git window (the same
      // pattern the changes view uses for its discard confirm).
      const title = t('dialog.stash.drop_confirm_title');
      const ok = await openDialogWindowForResult<boolean>(
        this.commands,
        this.events,
        'messagebox',
        title,
        {
          kind: 'confirm',
          title,
          message: this.i18n.t('dialog.stash.drop_confirm_msg', {
            ref: `stash@{${stash.index}}`,
          }),
        },
        false,
        this.bridge.currentWindowLabel(),
      );
      if (!ok) {
        return;
      }
    }
    try {
      const path = this.repoPath();
      if (picked === 'apply') {
        await this.commands.git.stashApply(path, stash.index);
      } else if (picked === 'pop') {
        await this.commands.git.stashPop(path, stash.index);
      } else {
        await this.commands.git.stashDrop(path, stash.index);
      }
      await this.loadStashes();
    } catch (err: unknown) {
      this.error.set(this.messageOf(err));
    }
  }

  /** Branch-identity color of the commit at list index `i` (ref chips). */
  protected laneColorAt(i: number): string {
    const row = this.graphRows()[i];
    if (!row) {
      return laneColor(0);
    }
    return (row.label !== undefined && this.branchPalette().get(row.label)) || laneColor(row.lane);
  }

  protected relDate(iso: string): string {
    return formatRelativeDate(iso, this.i18n.language());
  }

  // -- helpers ------------------------------------------------------------------

  protected short(sha: string): string {
    return shortSha(sha);
  }

  protected date(iso: string): string {
    return formatCommitDate(iso, this.i18n.language());
  }

  private async loadBranches(): Promise<void> {
    try {
      const ordered = await this.commands.git.branches(this.repoPath(), 500, true);
      this.branches.set(ordered.branches);
      this.recentCount.set(ordered.recentCount);
    } catch {
      // Branch dropdown is a convenience — history still works without it.
    }
  }

  private async loadTags(): Promise<void> {
    try {
      this.tags.set(await this.commands.git.tags(this.repoPath()));
    } catch {
      // Tag section is a convenience — the rev filter still accepts refs.
    }
  }

  private async loadAuthors(): Promise<void> {
    try {
      this.authors.set(await this.commands.git.authors(this.repoPath()));
    } catch {
      // Author dropdown degrades to "all authors".
    }
  }

  private async loadStashes(): Promise<void> {
    try {
      this.stashes.set(await this.commands.git.stashList(this.repoPath()));
    } catch (err: unknown) {
      this.error.set(this.messageOf(err));
    }
  }

  private async reload(): Promise<void> {
    this.commits.set([]);
    this.hasMore.set(false);
    this.view.set('list');
    this.resetDetail();
    await this.fetchPage(0);
  }

  private async fetchPage(skip: number): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const page = await this.commands.git.log(
        this.repoPath(),
        buildLogFilter(this.filters(), skip),
      );
      this.commits.update((existing) =>
        skip === 0 ? page.commits : [...existing, ...page.commits],
      );
      this.hasMore.set(page.hasMore);
    } catch (err: unknown) {
      this.error.set(this.messageOf(err));
    } finally {
      this.loading.set(false);
    }
  }

  /** Load the file list of `ref` into the shared panel. */
  private async openDetail(ref: string, source: PanelSource): Promise<void> {
    this.detailRef = ref;
    this.panelSource = source;
    this.resetDetail();
    this.detailLoading.set(true);
    try {
      this.files.set(await this.commands.git.commitFiles(this.repoPath(), ref));
    } catch (err: unknown) {
      this.error.set(this.messageOf(err));
    } finally {
      this.detailLoading.set(false);
    }
  }

  private async loadDiff(file: GitCommitFileStat): Promise<void> {
    this.notice.set('');
    if (file.binary) {
      this.notice.set(this.i18n.t('git.binary_file'));
      return;
    }
    this.detailLoading.set(true);
    try {
      const diff =
        this.panelSource === 'range'
          ? await this.commands.git.diffRangeFile(
              this.repoPath(),
              this.compareBase(),
              this.compareTarget(),
              file.path,
            )
          : await this.commands.git.commitFileDiff(this.repoPath(), this.detailRef, file.path);
      if (diff.binary) {
        this.notice.set(this.i18n.t('git.binary_file'));
      } else if (diff.tooLarge) {
        this.notice.set(this.i18n.t('git.diff_too_large'));
      } else {
        this.diffText.set(diff.content ?? '');
      }
    } catch (err: unknown) {
      this.error.set(this.messageOf(err));
    } finally {
      this.detailLoading.set(false);
    }
  }

  private resetDetail(): void {
    this.files.set([]);
    this.selectedFile.set('');
    this.detailMode.set('diff');
    this.notice.set('');
    this.diffText.set('');
    this.fileText.set('');
  }

  private messageOf(err: unknown): string {
    const maybe = err as { message?: string };
    return typeof maybe?.message === 'string' ? maybe.message : String(err);
  }
}

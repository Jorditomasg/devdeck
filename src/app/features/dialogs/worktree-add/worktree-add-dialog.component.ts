/**
 * New git worktree dialog (git-worktrees design 2026-10-12). Two modes:
 * a NEW branch (name + base) or an EXISTING branch — local, or remote-only
 * (then git creates a local tracking branch). Port pre-filled from
 * `git_worktree_suggest_port`. Resolves the created worktree's repo name, or
 * `null` on Cancel/ESC/✕.
 */
import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import { IpcCommands } from '../../../core/ipc/commands';
import { ReposStore } from '../../../core/state/repos.store';
import { ButtonComponent, DialogShellComponent, SearchableSelectComponent } from '../../../ui';
import { validateBranchName } from '../branch/branch.logic';
import { DialogBase } from '../dialog-base';
import { worktreeTargetPath } from './worktree-add.logic';

type Mode = 'new' | 'existing';

@Component({
  selector: 'app-worktree-add-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, SearchableSelectComponent, TPipe],
  styleUrl: './worktree-add-dialog.component.scss',
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.worktree.title' | t: { name: repoName() }"
      (closed)="closeSelf()"
    >
      <div class="wt">
        <div class="wt__modes">
          <label class="wt__check">
            <input type="radio" name="mode" [checked]="mode() === 'new'" (change)="mode.set('new')" />
            {{ 'dialog.worktree.mode_new' | t }}
          </label>
          <label class="wt__check">
            <input
              type="radio"
              name="mode"
              [checked]="mode() === 'existing'"
              (change)="mode.set('existing')"
            />
            {{ 'dialog.worktree.mode_existing' | t }}
          </label>
        </div>

        @if (mode() === 'new') {
          <div class="wt__row">
            <span class="wt__label">{{ 'dialog.worktree.branch_label' | t }}</span>
            <input
              #nameInput
              class="wt__input"
              type="text"
              [placeholder]="'dialog.branch.name_placeholder' | t"
              [value]="newName()"
              (input)="newName.set(nameInput.value)"
            />
          </div>
          <div class="wt__row">
            <span class="wt__label">{{ 'dialog.branch.base_label' | t }}</span>
            <ui-searchable-select
              class="wt__combo"
              [options]="localBranches()"
              [value]="base()"
              [searchPlaceholder]="'placeholder.search' | t"
              [noResultsText]="'placeholder.no_results' | t"
              (selectionChange)="base.set($event)"
            />
          </div>
        } @else {
          <div class="wt__row">
            <span class="wt__label">{{ 'dialog.worktree.branch_label' | t }}</span>
            <ui-searchable-select
              class="wt__combo"
              [options]="allBranches()"
              [value]="existing()"
              [searchPlaceholder]="'placeholder.search' | t"
              [noResultsText]="'placeholder.no_results' | t"
              (selectionChange)="existing.set($event)"
            />
          </div>
        }

        <div class="wt__row">
          <span class="wt__label">{{ 'dialog.worktree.port_label' | t }}</span>
          <input
            #portInput
            class="wt__input wt__input--port"
            type="number"
            min="1"
            max="65535"
            [value]="port() ?? ''"
            (input)="port.set(portInput.value === '' ? null : Number(portInput.value))"
          />
          <span class="wt__hint">{{ 'dialog.worktree.port_hint' | t }}</span>
        </div>

        <div class="wt__row">
          <span class="wt__label">{{ 'dialog.worktree.path_label' | t }}</span>
          <code class="wt__path">{{ targetPath() }}</code>
        </div>

        @if (error()) {
          <p class="wt__error">{{ error() }}</p>
        }
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" (clicked)="closeSelf()">{{ 'btn.cancel' | t }}</ui-button>
        <ui-button variant="blue" [loading]="busy()" [disabled]="branch() === ''" (clicked)="create()">
          {{ 'dialog.worktree.btn_create' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class WorktreeAddDialogComponent extends DialogBase {
  readonly repoName = input('');

  private readonly commands = inject(IpcCommands);
  private readonly repos = inject(ReposStore);
  private readonly i18n = inject(TranslationService);

  protected readonly Number = Number;
  protected readonly mode = signal<Mode>('new');
  protected readonly newName = signal('');
  protected readonly base = signal('');
  protected readonly existing = signal('');
  protected readonly port = signal<number | null>(null);
  protected readonly localBranches = signal<readonly string[]>([]);
  protected readonly allBranches = signal<readonly string[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  private readonly repoPath = computed(() => this.repos.repoByName(this.repoName())?.path ?? '');

  protected readonly branch = computed(() =>
    (this.mode() === 'new' ? this.newName() : this.existing()).trim(),
  );

  protected readonly targetPath = computed(() =>
    this.branch() === '' ? '' : worktreeTargetPath(this.repoPath(), this.branch()),
  );

  constructor() {
    super();
    // Inputs are bound after construction — load once rendered (branch dialog idiom).
    afterNextRender(() => void this.load());
  }

  private async load(): Promise<void> {
    const path = this.repoPath();
    if (!path) {
      return;
    }
    const [local, all, current, port] = await Promise.all([
      this.commands.git.branches(path, undefined, false).catch(() => null),
      this.commands.git.branches(path, undefined, true).catch(() => null),
      this.commands.git.currentBranch(path).catch(() => ''),
      this.commands.git.worktreeSuggestPort(this.repoName()).catch(() => null),
    ]);
    this.localBranches.set(local?.branches ?? []);
    this.allBranches.set(all?.branches ?? []);
    this.base.set(current !== 'unknown' ? current : '');
    this.port.set(port);
  }

  protected async create(): Promise<void> {
    const branch = this.branch();
    if (this.mode() === 'new') {
      const errorKey = validateBranchName(branch);
      if (errorKey) {
        this.error.set(this.i18n.t(errorKey));
        return;
      }
    }
    const port = this.port();
    if (port !== null && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
      this.error.set(this.i18n.t('dialog.worktree.error_port'));
      return;
    }
    // Existing mode: a name missing from the local list is remote-only
    // (listed origin-stripped) → create a local tracking branch off origin/<b>.
    // ponytail: assumes the `origin` remote; other remotes fail with git's message.
    const mode =
      this.mode() === 'new' ? 'new' : this.localBranches().includes(branch) ? 'existing' : 'remote';
    const base = mode === 'new' ? this.base() || null : mode === 'remote' ? `origin/${branch}` : null;

    this.busy.set(true);
    this.error.set('');
    try {
      const res = await this.commands.git.worktreeAdd(this.repoName(), branch, mode, base, port);
      if (res.ok && res.name) {
        this.closeSelf(res.name);
      } else {
        this.error.set(res.message);
      }
    } catch (err: unknown) {
      this.error.set(String((err as { message?: string })?.message ?? err));
    } finally {
      this.busy.set(false);
    }
  }
}

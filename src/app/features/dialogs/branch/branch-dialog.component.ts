/**
 * Branch-management dialog — create (off a base, optional checkout), and per
 * branch checkout / rename (prompt) / publish / delete-local (force fallback
 * when not merged) / delete-remote (confirmed). Mutations refresh the badge
 * and re-list; progress streams via `service://log-line` (`stream: "git"`).
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import { IpcCommands } from '../../../core/ipc/commands';
import type { OpOutput } from '../../../core/ipc/tauri.types';
import { ReposStore } from '../../../core/state/repos.store';
import { ButtonComponent, DialogShellComponent, SearchableSelectComponent } from '../../../ui';
import { DialogBase } from '../dialog-base';
import { validateBranchName } from './branch.logic';

@Component({
  selector: 'app-branch-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, SearchableSelectComponent, TPipe],
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.branch.title' | t: { name: repoName() }"
      width="600px"
      [cascadeLevel]="cascadeLevel()"
      (closed)="closeSelf()"
    >
      <div class="branch">
        <section class="branch__section">
          <h3 class="branch__section-title">{{ 'dialog.branch.create_section' | t }}</h3>
          <div class="branch__row">
            <input
              #nameInput
              class="branch__input"
              type="text"
              [placeholder]="'dialog.branch.name_placeholder' | t"
              [value]="newName()"
              [disabled]="busy()"
              (input)="newName.set(nameInput.value)"
            />
            <span class="branch__sublabel">{{ 'dialog.branch.base_label' | t }}</span>
            <ui-searchable-select
              class="branch__combo"
              [options]="branches()"
              [recentCount]="recentCount()"
              [value]="base()"
              [disabled]="busy()"
              [searchPlaceholder]="'placeholder.search' | t"
              [noResultsText]="'placeholder.no_results' | t"
              (selectionChange)="base.set($event)"
            />
            <label class="branch__check">
              <input
                type="checkbox"
                [checked]="checkoutAfter()"
                [disabled]="busy()"
                (change)="checkoutAfter.set(!checkoutAfter())"
              />
              {{ 'dialog.branch.checkout_after' | t }}
            </label>
            <ui-button variant="blue" [loading]="busy()" (clicked)="create()">
              {{ 'dialog.branch.btn_create' | t }}
            </ui-button>
          </div>
          @if (createError()) {
            <p class="branch__error">{{ createError() }}</p>
          }
        </section>

        <section class="branch__section">
          <h3 class="branch__section-title">{{ 'dialog.branch.list_section' | t }}</h3>
          @for (b of branches(); track b) {
            <div class="branch__entry">
              <span class="branch__entry-label">
                {{ b }}
                @if (b === current()) {
                  <span class="branch__current">({{ 'dialog.branch.current_tag' | t }})</span>
                }
              </span>
              <ui-button size="sm" variant="success" [disabled]="busy() || b === current()" (clicked)="checkout(b)">
                {{ 'dialog.branch.btn_checkout' | t }}
              </ui-button>
              <ui-button size="sm" variant="neutral" [disabled]="busy()" (clicked)="rename(b)">
                {{ 'dialog.branch.btn_rename' | t }}
              </ui-button>
              <ui-button size="sm" variant="blue" [disabled]="busy()" (clicked)="publish(b)">
                {{ 'dialog.branch.btn_publish' | t }}
              </ui-button>
              <ui-button size="sm" variant="purple" [disabled]="busy()" (clicked)="deleteRemote(b)">
                {{ 'dialog.branch.btn_delete_remote' | t }}
              </ui-button>
              <ui-button size="sm" variant="danger-deep" [disabled]="busy() || b === current()" (clicked)="deleteLocal(b)">
                {{ 'dialog.branch.btn_delete_local' | t }}
              </ui-button>
            </div>
          }
        </section>

        <p class="branch__log-label">{{ 'dialog.branch.log_label' | t }}</p>
        <pre class="branch__log">{{ logText() }}</pre>
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" (clicked)="closeSelf()">{{ 'btn.close' | t }}</ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class BranchDialogComponent extends DialogBase {
  readonly repoName = input.required<string>();

  private readonly commands = inject(IpcCommands);
  private readonly repos = inject(ReposStore);
  private readonly i18n = inject(TranslationService);

  protected readonly branches = signal<readonly string[]>([]);
  protected readonly recentCount = signal(0);
  protected readonly current = signal('');
  protected readonly newName = signal('');
  protected readonly base = signal('');
  protected readonly checkoutAfter = signal(true);
  protected readonly busy = signal(false);
  protected readonly createError = signal('');
  private readonly logLines = signal<readonly string[]>([]);

  protected readonly logText = computed(() => this.logLines().join('\n'));

  constructor() {
    super();
    void this.reload();
  }

  protected async create(): Promise<void> {
    const errorKey = validateBranchName(this.newName());
    if (errorKey) {
      this.createError.set(this.i18n.t(errorKey));
      return;
    }
    this.createError.set('');
    const name = this.newName().trim();
    const base = this.base().trim() || null;
    await this.run(
      () => this.commands.git.createBranch(this.repoPath(), name, base, this.checkoutAfter()),
      'dialog.branch.done_created',
    );
    this.newName.set('');
  }

  protected async checkout(branch: string): Promise<void> {
    await this.run(
      () => this.commands.git.checkout(this.repoPath(), branch),
      'dialog.branch.done_checked_out',
    );
  }

  protected async rename(branch: string): Promise<void> {
    const next = await this.dialogs.prompt(
      this.i18n.t('dialog.prompt.rename_title'),
      this.i18n.t('dialog.prompt.rename_msg', { name: branch }),
      { initialValue: branch },
    );
    if (next === null) {
      return;
    }
    const errorKey = validateBranchName(next);
    if (errorKey) {
      this.appendLog(this.i18n.t('dialog.branch.failed', { msg: this.i18n.t(errorKey) }));
      return;
    }
    await this.run(
      () => this.commands.git.renameBranch(this.repoPath(), branch, next.trim()),
      'dialog.branch.done_renamed',
    );
  }

  protected async publish(branch: string): Promise<void> {
    await this.run(
      () => this.commands.git.publishBranch(this.repoPath(), branch),
      'dialog.branch.done_published',
    );
  }

  protected async deleteRemote(branch: string): Promise<void> {
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.branch.delete_remote_confirm_title'),
      this.i18n.t('dialog.branch.delete_remote_confirm_msg', { name: branch }),
    );
    if (!confirmed) {
      return;
    }
    await this.run(
      () => this.commands.git.deleteRemoteBranch(this.repoPath(), branch),
      'dialog.branch.done_deleted',
    );
  }

  protected async deleteLocal(branch: string): Promise<void> {
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.branch.delete_confirm_title'),
      this.i18n.t('dialog.branch.delete_confirm_msg', { name: branch }),
    );
    if (!confirmed) {
      return;
    }
    const result = await this.runRaw(() =>
      this.commands.git.deleteBranch(this.repoPath(), branch, false),
    );
    if (result === null) {
      return;
    }
    if (result.ok) {
      this.appendLog(this.i18n.t('dialog.branch.done_deleted'));
      await this.afterMutation();
      return;
    }
    // Only a "not fully merged" failure warrants the forced -D path. Any other
    // failure (e.g. the name is a remote-only branch with no local ref) is just
    // logged — force-deleting would not fix it and the prompt would mislead.
    if (!/not fully merged/i.test(result.message)) {
      this.appendLog(this.i18n.t('dialog.branch.failed', { msg: result.message }));
      await this.afterMutation();
      return;
    }
    const force = await this.dialogs.confirm(
      this.i18n.t('dialog.branch.delete_force_title'),
      this.i18n.t('dialog.branch.delete_force_msg', { name: branch }),
    );
    if (!force) {
      this.appendLog(this.i18n.t('dialog.branch.failed', { msg: result.message }));
      return;
    }
    await this.run(
      () => this.commands.git.deleteBranch(this.repoPath(), branch, true),
      'dialog.branch.done_deleted',
    );
  }

  /** Run a mutation, log its outcome, refresh the badge, and re-list. */
  private async run(op: () => Promise<OpOutput>, okKey: string): Promise<void> {
    const result = await this.runRaw(op);
    if (result === null) {
      return;
    }
    this.appendLog(
      result.ok
        ? this.i18n.t(okKey)
        : this.i18n.t('dialog.branch.failed', { msg: result.message }),
    );
    await this.afterMutation();
  }

  /** Execute a mutation with the busy guard; returns the OpOutput or null. */
  private async runRaw(op: () => Promise<OpOutput>): Promise<OpOutput | null> {
    if (this.busy()) {
      return null;
    }
    this.busy.set(true);
    try {
      return await op();
    } catch (err: unknown) {
      this.appendLog(this.i18n.t('dialog.branch.failed', { msg: describe(err) }));
      return null;
    } finally {
      this.busy.set(false);
    }
  }

  private async afterMutation(): Promise<void> {
    void this.repos.refreshBadge(this.repoPath());
    await this.reload();
  }

  private async reload(): Promise<void> {
    const repoPath = this.repoPath();
    const [ordered, current] = await Promise.all([
      // Local-only list: branch management never operates on remote-only names.
      this.commands.git
        .branches(repoPath, undefined, false)
        .catch(() => ({ branches: [], recentCount: 0 })),
      this.commands.git.currentBranch(repoPath).catch(() => ''),
    ]);
    this.branches.set(ordered.branches);
    this.recentCount.set(ordered.recentCount);
    this.current.set(current);
    if (this.base() === '') {
      this.base.set(current);
    }
  }

  private repoPath(): string {
    return this.repos.repoByName(this.repoName())?.path ?? '';
  }

  private appendLog(line: string): void {
    this.logLines.update((lines) => [...lines, line]);
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

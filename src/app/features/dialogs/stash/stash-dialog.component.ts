/**
 * Stash-management dialog — add (with optional name + untracked), list, and
 * per-entry Apply / Pop / Drop. Mutations refresh the git badge and re-list;
 * progress streams via `service://log-line` (`stream: "git"`).
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
import type { OpOutput, StashEntry } from '../../../core/ipc/tauri.types';
import { ReposStore } from '../../../core/state/repos.store';
import { ButtonComponent, DialogShellComponent } from '../../../ui';
import { DialogBase } from '../dialog-base';
import { stashEntryLabel } from './stash.logic';

@Component({
  selector: 'app-stash-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, TPipe],
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.stash.title' | t: { name: repoName() }"
      width="560px"
      [cascadeLevel]="cascadeLevel()"
      (closed)="closeSelf()"
    >
      <div class="stash">
        <section class="stash__section">
          <h3 class="stash__section-title">{{ 'dialog.stash.add_section' | t }}</h3>
          <div class="stash__row">
            <input
              #nameInput
              class="stash__input"
              type="text"
              [placeholder]="'dialog.stash.name_placeholder' | t"
              [value]="name()"
              [disabled]="busy()"
              (input)="name.set(nameInput.value)"
            />
            <label class="stash__check">
              <input
                type="checkbox"
                [checked]="includeUntracked()"
                [disabled]="busy()"
                (change)="includeUntracked.set(!includeUntracked())"
              />
              {{ 'dialog.stash.include_untracked' | t }}
            </label>
            <ui-button variant="blue" [loading]="busy()" (clicked)="add()">
              {{ (busy() ? 'dialog.stash.btn_adding' : 'dialog.stash.btn_add') | t }}
            </ui-button>
          </div>
        </section>

        <section class="stash__section">
          <h3 class="stash__section-title">{{ 'dialog.stash.entries_section' | t }}</h3>
          @if (entries().length === 0) {
            <p class="stash__empty">{{ 'dialog.stash.empty' | t }}</p>
          } @else {
            @for (entry of entries(); track entry.index) {
              <div class="stash__entry">
                <span class="stash__entry-label">{{ label(entry) }}</span>
                <ui-button size="sm" variant="success" [disabled]="busy()" (clicked)="apply(entry)">
                  {{ 'dialog.stash.btn_apply' | t }}
                </ui-button>
                <ui-button size="sm" variant="blue" [disabled]="busy()" (clicked)="pop(entry)">
                  {{ 'dialog.stash.btn_pop' | t }}
                </ui-button>
                <ui-button size="sm" variant="danger-deep" [disabled]="busy()" (clicked)="drop(entry)">
                  {{ 'dialog.stash.btn_drop' | t }}
                </ui-button>
              </div>
            }
          }
        </section>

        <p class="stash__log-label">{{ 'dialog.stash.log_label' | t }}</p>
        <pre class="stash__log">{{ logText() }}</pre>
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" (clicked)="closeSelf()">{{ 'btn.close' | t }}</ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class StashDialogComponent extends DialogBase {
  readonly repoName = input.required<string>();

  private readonly commands = inject(IpcCommands);
  private readonly repos = inject(ReposStore);
  private readonly i18n = inject(TranslationService);

  protected readonly name = signal('');
  protected readonly includeUntracked = signal(true); // default ON (design)
  protected readonly entries = signal<readonly StashEntry[]>([]);
  protected readonly busy = signal(false);
  private readonly logLines = signal<readonly string[]>([]);

  protected readonly logText = computed(() => this.logLines().join('\n'));

  constructor() {
    super();
    void this.reload();
  }

  protected label(entry: StashEntry): string {
    return stashEntryLabel(entry);
  }

  protected async add(): Promise<void> {
    const message = this.name().trim() || null;
    await this.run(
      () => this.commands.git.stashPush(this.repoPath(), message, this.includeUntracked()),
      'dialog.stash.done_added',
    );
    this.name.set('');
  }

  protected async apply(entry: StashEntry): Promise<void> {
    await this.run(
      () => this.commands.git.stashApply(this.repoPath(), entry.index),
      'dialog.stash.done_applied',
    );
  }

  protected async pop(entry: StashEntry): Promise<void> {
    await this.run(
      () => this.commands.git.stashPop(this.repoPath(), entry.index),
      'dialog.stash.done_popped',
    );
  }

  protected async drop(entry: StashEntry): Promise<void> {
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.stash.drop_confirm_title'),
      this.i18n.t('dialog.stash.drop_confirm_msg', { ref: `stash@{${entry.index}}` }),
    );
    if (!confirmed) {
      return;
    }
    await this.run(
      () => this.commands.git.stashDrop(this.repoPath(), entry.index),
      'dialog.stash.done_dropped',
    );
  }

  /** Run a mutation, log its outcome, refresh the badge, and re-list. */
  private async run(op: () => Promise<OpOutput>, okKey: string): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    try {
      const result = await op();
      this.appendLog(
        result.ok
          ? this.i18n.t(okKey)
          : this.i18n.t('dialog.stash.failed', { msg: result.message }),
      );
      void this.repos.refreshBadge(this.repoPath());
      await this.reload();
    } catch (err: unknown) {
      this.appendLog(this.i18n.t('dialog.stash.failed', { msg: describe(err) }));
    } finally {
      this.busy.set(false);
    }
  }

  private async reload(): Promise<void> {
    const list = await this.commands.git.stashList(this.repoPath()).catch(() => [] as StashEntry[]);
    this.entries.set(list);
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

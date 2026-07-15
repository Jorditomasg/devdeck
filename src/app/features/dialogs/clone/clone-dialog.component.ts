/**
 * Clone-repository dialog — v1 `CloneDialog` (inventory-gui §15).
 *
 * - URL + optional folder name (auto-derived from the URL while untouched);
 * - destination = the active workspace group's first root (shown read-only);
 * - progress: `git_clone` forwards stderr progress as `service://log-line`
 *   batches with `stream: "git"` and `name` = dest basename (ipc-contract
 *   §2.4 #15) — the bar folds percentages out of those lines;
 * - success → info messagebox + workspace rescan (v1 fired `on_complete`
 *   = `_scan_repos`); failure → error messagebox, button re-enabled.
 *
 * Deviation from v1: the "folder already exists" pre-check (§15 step 2) has
 * no client-side filesystem access in v2 — the Rust `git_clone` fails with
 * the same condition and the error surfaces through the failure path.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import { IpcCommands } from '../../../core/ipc/commands';
import { ReposStore } from '../../../core/state/repos.store';
import { ServicesStore } from '../../../core/state/services.store';
import { SettingsStore } from '../../../core/state/settings.store';
import {
  ButtonComponent,
  DialogLogComponent,
  DialogShellComponent,
  FormRowComponent,
} from '../../../ui';
import { DialogBase } from '../dialog-base';
import { defaultFolderName, foldCloneProgress, isValidGitUrl } from './clone.logic';

@Component({
  selector: 'app-clone-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogLogComponent, DialogShellComponent, FormRowComponent, TPipe],
  styleUrl: './clone-dialog.component.scss',
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.clone.title' | t"
      [closeOnEscape]="!busy()"
      (closed)="onClose()"
    >
      <div class="clone">
        <ui-form-row [label]="'dialog.clone.url_label' | t" labelWidth="150px">
          <input
            #urlInput
            class="clone__input"
            type="text"
            [placeholder]="'dialog.clone.url_placeholder' | t"
            [disabled]="busy()"
            (input)="onUrlInput(urlInput.value)"
          />
        </ui-form-row>

        <ui-form-row [label]="'dialog.clone.folder_label' | t" labelWidth="150px">
          <input
            #folderInput
            class="clone__input"
            type="text"
            [placeholder]="'dialog.clone.folder_placeholder' | t"
            [value]="folder()"
            [disabled]="busy()"
            (input)="onFolderInput(folderInput.value)"
          />
        </ui-form-row>

        <ui-form-row [label]="'dialog.clone.destination' | t" labelWidth="150px">
          <span class="clone__dest" [title]="destination()">{{ destination() }}</span>
        </ui-form-row>

        @if (error()) {
          <p class="clone__error">{{ error() }}</p>
        }

        <div
          class="clone__bar"
          role="progressbar"
          [attr.aria-valuenow]="progress()"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div class="clone__bar-fill" [style.width.%]="progress()"></div>
        </div>

        <ui-dialog-log
          [label]="'dialog.clone.log_label' | t"
          [lines]="logLines()"
          [emptyText]="'label.log_empty' | t"
          [detachText]="'btn.detach_log' | t"
          [clearText]="'btn.clear_log' | t"
          [jumpText]="'log.jump_to_bottom' | t"
          [canDetach]="logName() !== ''"
          (detach)="detachLog()"
          (clear)="clearLog()"
        />
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" [disabled]="busy()" (clicked)="closeSelf()">
          {{ 'btn.cancel' | t }}
        </ui-button>
        <ui-button variant="blue" [loading]="busy()" (clicked)="clone()">
          {{ (busy() ? 'dialog.clone.btn_cloning' : 'dialog.clone.btn') | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class CloneDialogComponent extends DialogBase {
  private readonly commands = inject(IpcCommands);
  private readonly repos = inject(ReposStore);
  private readonly services = inject(ServicesStore);
  private readonly settings = inject(SettingsStore);
  private readonly i18n = inject(TranslationService);

  protected readonly url = signal('');
  protected readonly folder = signal('');
  protected readonly busy = signal(false);
  protected readonly progress = signal(0);
  protected readonly error = signal('');

  /** Name the git log lines arrive under while cloning (dest basename). */
  protected readonly logName = signal('');
  private logBaseline = 0;
  private folderTouched = false;

  /** Active group's first root — the clone destination directory. */
  protected readonly destination = computed(
    () => this.settings.activeGroup()?.paths[0] ?? '',
  );

  /** Git progress lines streamed during the clone (since the run started). */
  protected readonly logLines = computed<readonly string[]>(() => {
    const name = this.logName();
    if (name === '') {
      return [];
    }
    return this.services
      .logsFor(name)()
      .slice(this.logBaseline)
      .filter((l) => l.stream === 'git')
      .map((l) => l.line);
  });

  /** Detach the live log into its own OS window (reuses `open_log_window`). */
  protected detachLog(): void {
    const name = this.logName();
    if (name === '') {
      return;
    }
    void this.commands
      .openLogWindow(name, this.i18n.t('dialog.clone.title'))
      .catch((err: unknown) => console.error('open log window failed', err));
  }

  /** Clear the dialog's view of the log (non-destructive: baseline bump). */
  protected clearLog(): void {
    const name = this.logName();
    if (name !== '') {
      this.logBaseline = this.services.logsFor(name)().length;
    }
  }

  constructor() {
    super();
    // Fold streamed git percentages into the (monotonic) progress bar.
    effect(() => {
      const name = this.logName();
      if (name === '' || !this.busy()) {
        return;
      }
      const fresh = this.services
        .logsFor(name)()
        .slice(this.logBaseline)
        .filter((l) => l.stream === 'git')
        .map((l) => l.line);
      this.progress.update((p) => foldCloneProgress(p, fresh));
    });
  }

  protected onUrlInput(value: string): void {
    this.url.set(value);
    this.error.set('');
    if (!this.folderTouched) {
      this.folder.set(defaultFolderName(value));
    }
  }

  protected onFolderInput(value: string): void {
    this.folderTouched = value.trim() !== '';
    this.folder.set(value);
    if (!this.folderTouched) {
      this.folder.set(defaultFolderName(this.url()));
    }
  }

  protected async clone(): Promise<void> {
    if (this.busy()) {
      return;
    }
    const url = this.url().trim();
    if (url === '') {
      this.error.set(this.i18n.t('dialog.clone.error_no_url'));
      return;
    }
    if (!isValidGitUrl(url)) {
      this.error.set(this.i18n.t('dialog.clone.error_invalid_url'));
      return;
    }
    const folder = this.folder().trim() || defaultFolderName(url);
    if (folder === '') {
      this.error.set(this.i18n.t('dialog.clone.error_invalid_url'));
      return;
    }
    const dest = `${this.destination()}/${folder}`;

    this.error.set('');
    this.busy.set(true);
    this.progress.set(0);
    this.logBaseline = this.services.logsFor(folder)().length;
    this.logName.set(folder);

    try {
      const result = await this.commands.git.clone(url, dest);
      if (result.ok) {
        this.progress.set(100);
        await this.dialogs.info(
          this.i18n.t('dialog.clone.success_title'),
          this.i18n.t('dialog.clone.success_msg', { name: folder }),
        );
        const group = this.settings.activeGroup();
        if (group) {
          void this.repos.scan(group.paths); // v1 on_complete = _scan_repos
        }
        this.closeSelf();
      } else {
        await this.failed(result.message);
      }
    } catch (err: unknown) {
      await this.failed(err instanceof Error ? err.message : String(err));
    }
  }

  protected onClose(): void {
    if (!this.busy()) {
      this.closeSelf();
    }
  }

  private async failed(message: string): Promise<void> {
    this.busy.set(false);
    this.progress.set(0);
    await this.dialogs.error(
      this.i18n.t('misc.error_title'),
      this.i18n.t('dialog.clone.error_clone_msg', { msg: message }),
    );
  }
}

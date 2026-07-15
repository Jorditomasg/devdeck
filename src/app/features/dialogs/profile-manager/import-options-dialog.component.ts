/**
 * Import/Apply options wizard — v1 `ImportOptionsDialog` (inventory-gui §21).
 *
 * Step 1 (options + live preview): clone-missing checkbox, config-files
 * overwrite checkbox, Java mapping rows for versions the local registry
 * lacks, and a read-only mono preview of everything that will happen.
 *
 * Step 2 (progress, replaces step 1 on Accept): progress bar + detailed log.
 * Worker order (v1 :765-873): Java mappings → clones (5-worker pool, each
 * clone + profile-branch checkout) → `apply_profile_environments` (merges
 * `saved_environments` + writes `config_files`; the overwrite checkbox OFF
 * strips `config_files` first — the v2 command applies both together,
 * ipc-contract §2.7 #46).
 *
 * Promise-based: resolves {@link ImportApplyResult} on a completed apply,
 * `null` on cancel (the registered fallback). The PARENT (ProfileManager)
 * owns what happens next: staged-import save, rescan when cloned, and the
 * card-state apply (v1 `on_complete` callback).
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import { IpcCommands } from '../../../core/ipc/commands';
import type { MissingRepo, ProfileDocument } from '../../../core/ipc/tauri.types';
import { normalizeJavaVersion } from '../../../core/state/profiles.store';
import {
  ButtonComponent,
  DialogLogComponent,
  DialogShellComponent,
  IconComponent,
  SearchableSelectComponent,
} from '../../../ui';
import { DialogBase } from '../dialog-base';
import { NativePickers } from '../shared/native-pickers';
import {
  IMPORT_CLONE_CONCURRENCY,
  applyJavaMappings,
  countConfigFiles,
  javaMappingsNeeded,
  runLimited,
  stripConfigFiles,
} from './profile-manager.logic';

/** Resolved on a completed apply (`null` = cancelled). */
export interface ImportApplyResult {
  /** The document actually applied (Java mappings rewritten). */
  readonly doc: ProfileDocument;
  /** True when at least one repo was cloned (parent rescans, §21). */
  readonly didClone: boolean;
  /** Directory repos were cloned into — parent adds it to the active group. */
  readonly cloneDir: string;
}

@Component({
  selector: 'app-import-options-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    DialogLogComponent,
    DialogShellComponent,
    IconComponent,
    SearchableSelectComponent,
    TPipe,
  ],
  styleUrl: './import-options-dialog.component.scss',
  template: `
    <ui-dialog-shell
      #shell
      [dialogTitle]="'dialog.import.title' | t"
      (closed)="requestClose()"
    >
      @if (step() === 'options') {
        <div class="import">
          <p class="import__section-title">{{ 'dialog.import.section_title' | t }}</p>

          <!-- Missing-repos block (§21 step 1) -->
          @if (missing().length > 0) {
            <div class="import__block">
              <p class="import__missing-title">
                {{ 'dialog.import.missing_repos_title' | t }}
              </p>
              <p class="import__missing-names" [title]="missingNames()">
                {{ missingNames() }}
              </p>
              <label class="import__check">
                <input
                  type="checkbox"
                  [checked]="cloneMissing()"
                  (change)="cloneMissing.set(!cloneMissing())"
                />
                {{ 'dialog.import.clone_missing' | t }}
              </label>

              @if (cloneMissing()) {
                <p class="import__dest-label">
                  {{ 'dialog.import.download_dir_label' | t }}
                </p>
                <div class="import__dest-row">
                  <input
                    #destInput
                    class="import__input"
                    type="text"
                    [value]="cloneDir()"
                    [placeholder]="'dialog.import.download_dir_placeholder' | t"
                    (input)="cloneDir.set(destInput.value)"
                  />
                  <ui-button variant="neutral" (clicked)="browse()">
                    <ui-icon name="folder" [size]="14" /> {{ 'dialog.import.browse' | t }}
                  </ui-button>
                </div>
              }
            </div>
          }

          <!-- Config-files overwrite (§21 step 1) -->
          @if (overwriteCount() > 0) {
            <label class="import__check">
              <input
                type="checkbox"
                [checked]="overwriteFiles()"
                (change)="overwriteFiles.set(!overwriteFiles())"
              />
              {{ 'dialog.import.overwrite_files' | t: { count: overwriteCount() } }}
            </label>
          }

          <!-- Java mappings (§21 :497-596) -->
          @if (javaNeeds().length > 0) {
            <div class="import__block">
              <p class="import__missing-title">{{ 'dialog.import.map_java_title' | t }}</p>
              @for (need of javaNeeds(); track need.version) {
                <div class="import__java-row">
                  <span class="import__java-label">{{
                    'dialog.import.java_needs' | t: { version: need.version }
                  }}</span>
                  <ui-searchable-select
                    class="import__java-combo"
                    [options]="javaOptions()"
                    [value]="javaPick(need.version)"
                    [searchPlaceholder]="'placeholder.search' | t"
                    [noResultsText]="'placeholder.no_results' | t"
                    (selectionChange)="setJavaPick(need.version, $event)"
                  />
                </div>
                <p class="import__java-hint" [title]="need.repos.join(', ')">
                  {{ 'dialog.import.java_used_in' | t }}{{ need.repos.join(', ') }}
                </p>
              }
            </div>
          }

          <!-- Live preview (§21 step 1) -->
          <p class="import__section-title">{{ 'dialog.import.changes_summary' | t }}</p>
          <pre class="import__preview">{{ preview() }}</pre>
        </div>
      } @else {
        <!-- Step 2 — progress (§21) -->
        <div class="import">
          <p class="import__section-title">{{ 'dialog.import.applying_title' | t }}</p>
          <p class="import__progress-label">{{ progressLabel() }}</p>
          <div class="import__bar">
            <div class="import__bar-fill" [style.width.%]="progress() * 100"></div>
          </div>
          <ui-dialog-log
            [label]="'dialog.import.log_detail' | t"
            [lines]="logLines()"
            [emptyText]="'label.log_empty' | t"
            [clearText]="'btn.clear_log' | t"
            [jumpText]="'log.jump_to_bottom' | t"
            [canDetach]="false"
            (clear)="logLines.set([])"
          />
        </div>
      }

      <!-- Single top-level footer: @if'd content would miss the
           [uiDialogFooter] projection slot (embedded-view limitation). -->
      <div uiDialogFooter>
        @if (step() === 'options') {
          <ui-button variant="neutral" size="lg" (clicked)="closeSelf(null)">
            {{ 'btn.cancel' | t }}
          </ui-button>
          <ui-button variant="success" size="lg" (clicked)="accept()">
<ui-icon name="check" [size]="14" /> {{ 'dialog.import.btn_accept' | t }}
          </ui-button>
        } @else if (working()) {
          <ui-button variant="success" size="lg" [loading]="true" [disabled]="true">
            {{ 'dialog.import.btn_applying' | t }}
          </ui-button>
        } @else {
          <ui-button variant="success" size="lg" (clicked)="finish()">
<ui-icon name="check" [size]="14" /> {{ 'dialog.import.btn_close' | t }}
          </ui-button>
        }
      </div>
    </ui-dialog-shell>
  `,
})
export class ImportOptionsDialogComponent extends DialogBase {
  /** Window kind for opening this as a child dialog window (minify-safe). */
  static readonly dialogKind = 'import-options';

  /** The loaded/imported profile document. */
  readonly doc = input.required<ProfileDocument>();
  /** Clone-missing plan (`get_missing_repos`, contract §2.7 #45). */
  readonly missing = input<readonly MissingRepo[]>([]);
  /** Already-translated branch/profile change lines (parent-built, §21). */
  readonly changeLines = input<readonly string[]>([]);
  /** Active workspace root — clone destination + env-apply target. */
  readonly workspaceDir = input.required<string>();
  /** Local JDK registry labels (mapping combo options). */
  readonly localJava = input<readonly string[]>([]);

  private readonly commands = inject(IpcCommands);
  private readonly i18n = inject(TranslationService);
  private readonly pickers = inject(NativePickers);
  private readonly shell = viewChild.required<DialogShellComponent>('shell');

  protected readonly step = signal<'options' | 'progress'>('options');
  protected readonly cloneMissing = signal(true); // v1 default ON
  protected readonly overwriteFiles = signal(true); // v1 default ON
  protected readonly javaMapping = signal<Readonly<Record<string, string>>>({});
  protected readonly working = signal(false);
  protected readonly failed = signal(false);
  protected readonly progress = signal(0);
  protected readonly progressLabel = signal('');
  protected readonly logLines = signal<readonly string[]>([]);
  /** Clone destination, seeded from the active workspace path (user-editable). */
  protected readonly cloneDir = linkedSignal(() => this.workspaceDir());

  private result: ImportApplyResult | null = null;

  protected readonly overwriteCount = computed(() => countConfigFiles(this.doc()));
  protected readonly javaNeeds = computed(() =>
    javaMappingsNeeded(this.doc(), this.localJava()),
  );
  protected readonly javaOptions = computed<readonly string[]>(() => [
    this.i18n.t('label.java_default'),
    ...this.localJava(),
  ]);
  protected readonly missingNames = computed(() =>
    truncate(this.missing().map((m) => m.name).join(', '), 80),
  );

  /** Live preview lines (v1 read-only textbox, re-built on toggles). */
  protected readonly preview = computed(() => {
    const lines: string[] = [];
    if (this.changeLines().length > 0) {
      lines.push(this.i18n.t('dialog.import.changes_header'), ...this.changeLines());
    }
    if (this.cloneMissing() && this.missing().length > 0) {
      lines.push(this.i18n.t('dialog.import.clone_header'));
      for (const repo of this.missing()) {
        lines.push(
          this.i18n.t('dialog.import.will_clone', {
            name: repo.name,
            branch: repo.branch,
            java: this.javaSuffix(repo.name),
          }),
        );
      }
    }
    if (this.overwriteFiles() && this.overwriteCount() > 0) {
      lines.push(
        this.i18n.t('dialog.import.will_overwrite', { count: this.overwriteCount() }),
      );
    }
    return lines.length > 0
      ? lines.join('\n')
      : this.i18n.t('dialog.import.no_changes_selected');
  });

  protected javaPick(version: string): string {
    const picked = this.javaMapping()[version] ?? '';
    return picked === '' ? this.i18n.t('label.java_default') : picked;
  }

  protected setJavaPick(version: string, label: string): void {
    const value = label === this.i18n.t('label.java_default') ? '' : label;
    this.javaMapping.update((m) => ({ ...m, [version]: value }));
  }

  /** Pick the clone destination directory via the native folder chooser. */
  protected async browse(): Promise<void> {
    const picked = await this.pickers.pickDirectory(
      this.i18n.t('dialog.import.download_dir_label'),
    );
    if (picked !== null) {
      this.cloneDir.set(picked);
    }
  }

  // -- worker (§21 step 2) -------------------------------------------------------

  protected async accept(): Promise<void> {
    if (this.working()) {
      return;
    }
    this.step.set('progress');
    this.working.set(true);
    this.progressLabel.set(this.i18n.t('dialog.import.preparing'));
    try {
      // 1. Java mappings (the whole needs-list maps; unset rows = default).
      const mapping = Object.fromEntries(
        this.javaNeeds().map((n) => [n.version, this.javaMapping()[n.version] ?? '']),
      );
      const mapped = applyJavaMappings(this.doc(), mapping);

      const cloneTargets =
        this.cloneMissing() && this.missing().length > 0 ? this.missing() : [];
      // Repos download here (defaults to the active workspace path); env-apply
      // targets the same dir so it finds the freshly-cloned repos.
      const targetDir =
        cloneTargets.length > 0
          ? this.cloneDir().trim() || this.workspaceDir()
          : this.workspaceDir();
      const totalTicks = cloneTargets.length + 1;
      let ticks = 0;
      const tick = (): void => {
        ticks += 1;
        this.progress.set(Math.min(1, ticks / totalTicks));
      };

      // 2. Clone missing repos (5-worker pool; clone → profile-branch checkout).
      let didClone = false;
      await runLimited(cloneTargets, IMPORT_CLONE_CONCURRENCY, async (repo) => {
        try {
          if (!repo.gitUrl) {
            this.log(this.i18n.t('dialog.import.no_url', { name: repo.name }));
            return;
          }
          this.progressLabel.set(
            this.i18n.t('dialog.import.cloning_progress', { name: repo.name }),
          );
          this.log(this.i18n.t('log.import_cloning', { name: repo.name }));
          const dest = `${targetDir}/${repo.name}`;
          const cloned = await this.commands.git.clone(repo.gitUrl, dest);
          if (!cloned.ok) {
            this.log(
              this.i18n.t('log.import_clone_error', {
                name: repo.name,
                msg: cloned.message,
              }),
            );
            return;
          }
          if (repo.branch) {
            await this.commands.git.checkout(dest, repo.branch);
          }
          didClone = true;
          this.log(`✅ ${repo.name}`);
        } finally {
          tick();
        }
      });

      // 3. Saved environments + (optionally) embedded config files (#46).
      this.progressLabel.set(this.i18n.t('dialog.import.applying_configs'));
      const envDoc = this.overwriteFiles() ? mapped : stripConfigFiles(mapped);
      const report = await this.commands.profiles.applyProfileEnvironments(
        envDoc,
        targetDir,
      );
      const renames = Object.entries(report.renames)
        .flatMap(([key, map]) =>
          Object.entries(map).map(([from, to]) => `${key}: ${from} → ${to}`),
        )
        .join('; ');
      if (renames !== '') {
        this.log(this.i18n.t('log.import_configs_renamed', { summary: renames }));
      }
      this.log(this.i18n.t('dialog.import.envs_imported'));
      tick();

      // 4. Completion (§21 :748-763).
      this.progress.set(1);
      this.progressLabel.set(this.i18n.t('dialog.import.completed'));
      this.result = { doc: mapped, didClone, cloneDir: targetDir };
      this.working.set(false);
      await this.dialogs.info(
        this.i18n.t('dialog.import.done_title'),
        this.i18n.t('log.import_complete'),
      );
    } catch (err: unknown) {
      this.failed.set(true);
      this.working.set(false);
      this.log(`❌ ${describe(err)}`);
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    }
  }

  /** Close after completion: resolves the apply result (v1 `on_complete`). */
  protected finish(): void {
    this.closeSelf(this.failed() ? null : this.result);
  }

  /** ESC/✕: blocked while the worker runs (knock), otherwise cancel/finish. */
  protected requestClose(): void {
    if (this.working()) {
      this.shell().knock();
      return;
    }
    if (this.step() === 'progress') {
      this.finish();
      return;
    }
    this.closeSelf(null);
  }

  private javaSuffix(repoName: string): string {
    const version = normalizeJavaVersion(this.doc().repos[repoName]?.java_version);
    if (version === undefined) {
      return '';
    }
    const mapped = this.javaMapping()[version];
    const effective = mapped === '' ? undefined : (mapped ?? version);
    return effective
      ? this.i18n.t('dialog.import.uses_java', { version: effective })
      : '';
  }

  private log(line: string): void {
    this.logLines.update((lines) => [...lines, line]);
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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

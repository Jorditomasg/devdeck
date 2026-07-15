import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { GitCommitFileStat } from '../../../core/ipc/tauri.types';
import { BadgeComponent, DiffViewComponent, SpinnerComponent, ButtonComponent } from '../../../ui';
// Direct import ON PURPOSE (not via the ui barrel): keeps CodeMirror out of
// the initial bundle — see the note in ui/index.ts.
import { CodeViewComponent } from '../../../ui/code-view/code-view.component';
import { fileMatchesQuery, sortFilesFirst } from './git-window.logic';

/** Static translated strings of the panel (container translates). */
export interface FileDiffPanelText {
  readonly selectFile: string;
  readonly viewFile: string;
  readonly backToDiff: string;
  readonly binaryBadge: string;
  readonly emptyDiff: string;
  readonly fileHistory: string;
  readonly filterFiles: string;
}

/**
 * Reusable master-detail viewer (git suite phase 2): file list with ±
 * counts on the left, diff or full-file CodeMirror view on the right. ONE
 * component for every "files + code" surface — commit detail and stash
 * contents today, the phase-4 conflict resolver next. Presentational: the
 * container owns fetching; this panel only renders inputs and emits
 * selections.
 */
@Component({
  selector: 'git-file-diff-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BadgeComponent, ButtonComponent, CodeViewComponent, DiffViewComponent, SpinnerComponent],
  styleUrl: './file-diff-panel.component.scss',
  template: `
    <aside class="fdp__side">
      <input
        class="fdp__filter"
        type="text"
        [placeholder]="text().filterFiles"
        [value]="filterQuery()"
        (input)="filterChanged.emit($any($event.target).value)"
      />
      <ul class="fdp__files">
        @for (file of sortedFiles(); track file.path) {
          <li
            class="fdp__file"
            [class.fdp__file--selected]="file.path === selectedPath()"
            [class.fdp__file--dim]="dimmed(file)"
            (click)="fileSelected.emit(file)"
            (contextmenu)="fileMenuRequested.emit({ event: $event, file })"
          >
            <span class="fdp__path" [title]="file.path">
              @if (file.oldPath) {
                <span class="fdp__old">{{ file.oldPath }} → </span>
              }{{ file.path }}
            </span>
            @if (file.binary) {
              <ui-badge tone="muted">{{ text().binaryBadge }}</ui-badge>
            } @else {
              <span class="fdp__adds">+{{ file.additions }}</span>
              <span class="fdp__dels">−{{ file.deletions }}</span>
            }
          </li>
        }
      </ul>
    </aside>

    <div class="fdp__viewer">
      @if (loading()) {
        <div class="fdp__center"><ui-spinner /></div>
      } @else if (!selectedPath()) {
        <div class="fdp__center fdp__muted">{{ text().selectFile }}</div>
      } @else {
        <div class="fdp__bar">
          <span class="fdp__name" [title]="selectedPath()">{{ selectedPath() }}</span>
          <span class="fdp__spacer"></span>
          @if (showFileHistory()) {
            <ui-button variant="log-action" size="sm" (clicked)="fileHistory.emit(selectedPath())">
              {{ text().fileHistory }}
            </ui-button>
          }
          @if (mode() === 'diff') {
            <ui-button variant="log-action" size="sm" (clicked)="viewFile.emit()">
              {{ text().viewFile }}
            </ui-button>
          } @else if (mode() === 'file') {
            <ui-button variant="log-action" size="sm" (clicked)="backToDiff.emit()">
              {{ text().backToDiff }}
            </ui-button>
          }
        </div>
        @if (notice()) {
          <div class="fdp__center fdp__muted">{{ notice() }}</div>
        } @else if (mode() === 'diff') {
          <ui-diff-view class="fdp__pane" [diff]="diffText()" [emptyText]="text().emptyDiff" />
        } @else {
          <ui-code-view class="fdp__pane" [content]="fileText()" [fileName]="selectedPath()" />
        }
      }
    </div>
  `,
})
export class FileDiffPanelComponent {
  readonly files = input.required<readonly GitCommitFileStat[]>();
  readonly selectedPath = input('');
  readonly mode = input<'diff' | 'file'>('diff');
  readonly diffText = input('');
  readonly fileText = input('');
  /** Translated binary/too-large replacement message ('' = none). */
  readonly notice = input('');
  readonly loading = input(false);
  /** Shows the "file history" jump (history-window consumers only). */
  readonly showFileHistory = input(false);
  /** File-list search query — container-owned so it can prefill it. */
  readonly filterQuery = input('');
  readonly text = input.required<FileDiffPanelText>();

  /** Matches first (nothing hidden), original order within each group. */
  protected readonly sortedFiles = computed(() =>
    sortFilesFirst(this.files(), this.filterQuery()),
  );

  protected dimmed(file: GitCommitFileStat): boolean {
    const q = this.filterQuery().trim().toLowerCase();
    return q.length > 0 && !fileMatchesQuery(file, q);
  }

  readonly fileSelected = output<GitCommitFileStat>();
  /** Live query typed in the file-list search box. */
  readonly filterChanged = output<string>();
  readonly viewFile = output<void>();
  readonly backToDiff = output<void>();
  /** Emits the selected path — the container scopes the log to it. */
  readonly fileHistory = output<string>();
  /** Right-click on a file row — the container opens the menu. */
  readonly fileMenuRequested = output<{ event: MouseEvent; file: GitCommitFileStat }>();
}

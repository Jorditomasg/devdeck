import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { ButtonComponent } from '../button/button.component';
import { IconComponent } from '../icon/icon.component';
import { LogViewerComponent } from '../log-viewer/log-viewer.component';
import { DEFAULT_MAX_LINES } from '../log-viewer/log-viewer.logic';
import { SectionHeaderComponent } from '../section-header/section-header.component';

/**
 * Action-log panel for dialogs — the boxed live log used by the merge / clone
 * / stash / branch / docker dialogs, with a header carrying Detach + Clear
 * (inventory-gui §8 log header pattern). Presentational only: the container
 * owns the buffer and wires `detach` to `open_log_window` and `clear` to its
 * own view-reset (baseline bump / `clearLogs`) — see {@link CardLogComponent}.
 *
 * `canDetach=false` hides Detach for logs with no backing service id (e.g. the
 * profile-import detail log).
 */
@Component({
  selector: 'ui-dialog-log',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './dialog-log.component.scss',
  imports: [ButtonComponent, IconComponent, LogViewerComponent, SectionHeaderComponent],
  template: `
    <ui-section-header [label]="label()">
      @if (canDetach()) {
        <ui-button variant="log-action" size="sm" (clicked)="detach.emit()">
          <ui-icon name="external-link" [size]="13" /> {{ detachText() }}
        </ui-button>
      }
      <ui-button variant="log-action" size="sm" (clicked)="clear.emit()">
        <ui-icon name="trash" [size]="13" /> {{ clearText() }}
      </ui-button>
    </ui-section-header>

    <ui-log-viewer
      class="dialog-log__view"
      [lines]="lines()"
      [startIndex]="startIndex()"
      [maxLines]="maxLines()"
      [emptyText]="emptyText()"
      [jumpToBottomLabel]="jumpText()"
    />
  `,
})
export class DialogLogComponent {
  /** Header title (already translated). */
  readonly label = input('');
  /** Pre-formatted log lines. */
  readonly lines = input<readonly string[]>([]);
  /** Lines already trimmed upstream (stable `ui-log-viewer` track keys). */
  readonly startIndex = input(0);
  /** Render cap (default 500, v1 LOG_MAX_LINES). */
  readonly maxLines = input(DEFAULT_MAX_LINES);
  /** Placeholder when there are no lines yet (already translated). */
  readonly emptyText = input('');
  /** Detach button label (already translated). */
  readonly detachText = input('');
  /** Clear button label (already translated). */
  readonly clearText = input('');
  /** Jump-to-bottom button aria-label/tooltip (already translated). */
  readonly jumpText = input('');
  /** Hide Detach when the log has no backing service id. */
  readonly canDetach = input(true);

  readonly detach = output<void>();
  readonly clear = output<void>();
}

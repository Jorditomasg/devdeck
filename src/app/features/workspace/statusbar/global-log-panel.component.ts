/**
 * Global log panel container (inventory-gui.md §5) — collapsible in-page
 * panel above the status bar. Detach opens a real OS window (v1 parity) via
 * `open_log_window` with the `GLOBAL_LOG_ID` aggregate; the in-page buffer
 * is `ServicesStore.globalLog` (Rust-fed, 1000-line cap).
 *
 * Clearing is a VIEW concern (`global-log.logic.ts`): the store buffer has no
 * clear API, so we remember the last visible entry as a marker and render
 * only what arrived after it.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from '@angular/core';

import { TranslationService } from '../../../core/i18n/translation.service';
import { GLOBAL_LOG_ID, IpcCommands } from '../../../core/ipc/commands';
import {
  ServicesStore,
  type GlobalLogLine,
} from '../../../core/state/services.store';
import {
  ButtonComponent,
  IconComponent,
  LogViewerComponent,
  TooltipDirective,
} from '../../../ui';
import { formatGlobalLine, linesAfterMarker } from './global-log.logic';

@Component({
  selector: 'app-global-log-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, LogViewerComponent, TooltipDirective],
  styleUrl: './global-log-panel.component.scss',
  template: `
    <div class="glog__header" (click)="open.set(!open())">
      <span class="glog__chevron">
        @if (open()) {
          <ui-icon name="chevron-down" />
        } @else {
          <ui-icon name="chevron-up" />
        }
      </span>
      <span class="glog__title" [uiTooltip]="i18n.t('tooltip.expand')">
        {{ i18n.t('label.global_log_section') }}
      </span>
      <span class="glog__count">({{ lines().length }})</span>
      <span class="glog__spacer"></span>
      @if (open()) {
        <div class="glog__actions" (click)="$event.stopPropagation()">
          <ui-button
            variant="log-action"
            size="sm"
            [uiTooltip]="i18n.t('tooltip.copy_log')"
            (clicked)="onCopy()"
          ><ui-icon name="copy" [size]="13" /> {{ i18n.t('btn.copy_log') }}</ui-button>
          <ui-button variant="log-action" size="sm" (clicked)="onDetach()">
            <ui-icon name="external-link" [size]="13" /> {{ i18n.t('btn.detach_log') }}
          </ui-button>
          <ui-button variant="log-action" size="sm" (clicked)="onClear()">
            <ui-icon name="trash" [size]="13" /> {{ i18n.t('btn.clear_log') }}
          </ui-button>
        </div>
      }
    </div>

    @if (open()) {
      <ui-log-viewer
        class="glog__view"
        [lines]="lines()"
        [maxLines]="1000"
        [emptyText]="i18n.t('label.log_empty')"
      />
    }
  `,
})
export class GlobalLogPanelComponent {
  /** Collapsed by default — dense desktop layout (§1). */
  protected readonly open = signal(false);
  /** Clear marker — render only entries after it (`linesAfterMarker`). */
  private readonly marker = signal<GlobalLogLine | null>(null);

  protected readonly lines = computed(() =>
    linesAfterMarker(this.services.globalLog(), this.marker()).map(
      formatGlobalLine,
    ),
  );

  constructor(
    protected readonly i18n: TranslationService,
    private readonly services: ServicesStore,
    private readonly commands: IpcCommands,
  ) {}

  /** Detach = real OS window with the aggregated log (v1 parity, §5). */
  protected onDetach(): void {
    void this.commands
      .openLogWindow(GLOBAL_LOG_ID, this.i18n.t('label.global_log_section'))
      .catch((err: unknown) => console.error('open global log window failed', err));
  }

  protected onClear(): void {
    const buffer = this.services.globalLog();
    this.marker.set(buffer.length > 0 ? (buffer[buffer.length - 1] ?? null) : null);
  }

  protected onCopy(): void {
    void navigator.clipboard
      .writeText(this.lines().join('\n'))
      .catch(() => undefined);
  }
}

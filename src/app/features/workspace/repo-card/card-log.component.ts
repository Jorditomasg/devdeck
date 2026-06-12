/**
 * Repo card log row — presentational (inventory-gui.md §8). Header with the
 * detach/copy/clear actions + the `ui-log-viewer` body. All text arrives
 * translated through {@link CardLogText}; the container owns the buffer
 * (ServicesStore), the clipboard write and the URL opening.
 *
 * Detach opens a real OS window (v1 parity): the button emits
 * `detachToggle` and the container calls the `open_log_window` command.
 *
 * The clickable port/URL affordance (§8 task spec): when the container
 * detects a service URL (`serviceUrl` in card-logic.ts) it renders as a
 * link-styled button in the header; clicking emits `urlClicked` (container →
 * `OpenerService.openUrl`).
 */
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import {
  ButtonComponent,
  LogViewerComponent,
  SectionHeaderComponent,
  TooltipDirective,
} from '../../../ui';

/** Every translated string the log row renders (built in the container). */
export interface CardLogText {
  readonly title: string;
  readonly clearText: string;
  readonly copyText: string;
  readonly copyTip: string;
  readonly detachText: string;
  readonly urlTip: string;
  readonly emptyText: string;
}

@Component({
  selector: 'app-card-log',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, LogViewerComponent, SectionHeaderComponent, TooltipDirective],
  styleUrl: './card-log.component.scss',
  template: `
    <ui-section-header [label]="text().title">
      @if (url(); as u) {
        <button
          type="button"
          class="log-url"
          [uiTooltip]="text().urlTip"
          (click)="urlClicked.emit()"
        >🔗 {{ u }}</button>
      }
      <ui-button
        variant="log-action"
        size="sm"
        [uiTooltip]="text().copyTip"
        (clicked)="copyClicked.emit()"
      >{{ text().copyText }}</ui-button>
      <ui-button variant="log-action" size="sm" (clicked)="detachToggle.emit()">
        {{ text().detachText }}
      </ui-button>
      <ui-button variant="log-action" size="sm" (clicked)="clearClicked.emit()">
        {{ text().clearText }}
      </ui-button>
    </ui-section-header>

    <ui-log-viewer
      class="log-view"
      [lines]="lines()"
      [startIndex]="startIndex()"
      [emptyText]="text().emptyText"
    />
  `,
})
export class CardLogComponent {
  /** Pre-formatted log lines (stream prefixes applied by the container). */
  readonly lines = input<readonly string[]>([]);
  /** Lines already trimmed upstream (stable `ui-log-viewer` track keys). */
  readonly startIndex = input(0);
  /** Detected service URL; `null` hides the link (§8 clickable port). */
  readonly url = input<string | null>(null);
  readonly text = input.required<CardLogText>();

  readonly clearClicked = output<void>();
  readonly copyClicked = output<void>();
  readonly detachToggle = output<void>();
  readonly urlClicked = output<void>();
}

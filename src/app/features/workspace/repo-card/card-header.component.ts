/**
 * Repo card header — presentational (inventory-gui.md §6). All text arrives
 * already translated through {@link CardHeaderText}; every interaction is an
 * output, side effects live in the `app-repo-card` container.
 *
 * Layout parity with v1 `_header.py`: click anywhere toggles expand; the
 * right action group is `flex-shrink: 0` so growing hint labels can never
 * push the buttons off-screen (§33 "Buttons reserve space"); button
 * visibility/enable comes pre-computed via `card-visibility.ts` (§6 matrix).
 */
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import {
  BadgeComponent,
  IconButtonComponent,
  IconComponent,
  StatusDotComponent,
  TooltipDirective,
} from '../../../ui';
import type { DotStatus, HeaderButtonVisibility } from './card-visibility';

/** Every translated string the header renders (built in the container). */
export interface CardHeaderText {
  readonly startTip: string;
  readonly stopTip: string;
  readonly restartTip: string;
  readonly openExplorerTip: string;
  readonly openTerminalTip: string;
  readonly expandTip: string;
  readonly openRepoTip: string;
  readonly pullTip: string;
  readonly changesTip: string;
  readonly conflictsTip: string;
  readonly dangerTip: string;
  readonly dangerLabel: string;
  readonly depsWarnLabel: string;
  readonly depsWarnTip: string;
}

@Component({
  selector: 'app-card-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BadgeComponent,
    IconButtonComponent,
    IconComponent,
    StatusDotComponent,
    TooltipDirective,
  ],
  styleUrl: './card-header.component.scss',
  template: `
    <div
      class="header"
      role="button"
      tabindex="0"
      [attr.aria-expanded]="expanded()"
      (click)="toggleExpand.emit()"
      (keydown.enter)="toggleExpand.emit()"
      (keydown.space)="onSpaceToggle($event)"
      (contextmenu)="menuRequested.emit($event)"
    >
      <!-- §6 item 1: selection checkbox (stops expand toggle) -->
      <label class="header__check" (click)="$event.stopPropagation()">
        <input
          type="checkbox"
          [checked]="selected()"
          (change)="selectedChange.emit($any($event.target).checked)"
        />
      </label>

      <!-- §6 item 2: status dot with 3s logging flash (§8) -->
      <ui-status-dot [status]="dot()" [flashTick]="flashTick()" [label]="statusText()" />

      <!-- §6 item 3: type badge on ui_config.color (kept — shows repo type) -->
      <ui-badge tone="solid" [bg]="typeColor()">{{ typeLabel() }}</ui-badge>

      <!-- §6 item 4: name; right-click anywhere on the header opens the repo
           actions menu (container-owned). The ui_config.icon emoji was removed
           (cleaner header, user request); the type badge stays. -->
      <span class="header__name" [uiTooltip]="text().openRepoTip">
        {{ name() }}
      </span>

      <!-- §6 item 5: badges -->
      @if (behind() > 0) {
        <ui-badge
          tone="accent"
          [interactive]="true"
          [uiTooltip]="text().pullTip"
          (click)="onBadgeClick($event, 'pull')"
        >
          <ui-icon name="download" [size]="12" /> {{ behind() }}
        </ui-badge>
      }
      @if (changes() > 0) {
        <ui-badge
          tone="warning"
          [interactive]="true"
          [uiTooltip]="text().changesTip"
          (click)="onBadgeClick($event, 'changes')"
        >
          <ui-icon name="file-text" [size]="12" /> {{ changes() }}
        </ui-badge>
      }
      @if (conflicts() > 0) {
        <ui-badge
          tone="error"
          [interactive]="true"
          [uiTooltip]="text().conflictsTip"
          (click)="onBadgeClick($event, 'conflicts')"
        >
          <ui-icon name="alert-triangle" [size]="12" /> {{ conflicts() }}
        </ui-badge>
      }
      @if (danger()) {
        <ui-badge tone="warning" [uiTooltip]="text().dangerTip">
          {{ text().dangerLabel }}
        </ui-badge>
      }
      @if (depsWarning()) {
        <ui-badge tone="warning" [mono]="true" [uiTooltip]="text().depsWarnTip">
          {{ text().depsWarnLabel }}
        </ui-badge>
      }

      <!-- §6 item 5: grey hint (⎇ branch  ⚙ profile  $ cmd), fills the gap -->
      <span class="header__hint">{{ hint() }}</span>

      <!-- §6 right group: status text, port, actions (flex-shrink: 0) -->
      <div class="header__right" (click)="$event.stopPropagation()">
        <span class="header__status header__status--{{ dot() }}">{{ statusText() }}</span>
        @if (port(); as p) {
          <span class="header__port">:{{ p }}</span>
        }

        <div class="header__actions">
          @if (vis().showStart) {
            <ui-icon-button
              variant="start"
              [disabled]="!vis().startEnabled"
              [uiTooltip]="text().startTip"
              (clicked)="start.emit()"
            ><ui-icon name="play" /></ui-icon-button>
          }
          @if (vis().showStop) {
            <ui-icon-button
              variant="danger"
              [disabled]="!vis().stopEnabled"
              [uiTooltip]="text().stopTip"
              (clicked)="stop.emit()"
            ><ui-icon name="square" /></ui-icon-button>
          }
          @if (vis().showRestart) {
            <ui-icon-button
              variant="warning"
              [disabled]="!vis().restartEnabled"
              [uiTooltip]="text().restartTip"
              (clicked)="restart.emit()"
            ><ui-icon name="refresh" /></ui-icon-button>
          }
          <ui-icon-button
            variant="neutral"
            [uiTooltip]="text().openExplorerTip"
            (clicked)="openExplorer.emit()"
          ><ui-icon name="folder" /></ui-icon-button>
          <ui-icon-button
            variant="neutral"
            [uiTooltip]="text().openTerminalTip"
            (clicked)="openTerminal.emit()"
          ><ui-icon name="terminal" /></ui-icon-button>
          <ui-icon-button
            variant="toggle-expand"
            [uiTooltip]="text().expandTip"
            (clicked)="toggleExpand.emit()"
          >@if (expanded()) {
              <ui-icon name="chevron-up" />
            } @else {
              <ui-icon name="chevron-down" />
            }</ui-icon-button>
        </div>
      </div>
    </div>
  `,
})
export class CardHeaderComponent {
  readonly name = input.required<string>();
  /** Title-cased repo type (`repoTypeLabel`). */
  readonly typeLabel = input('');
  /** ui_config.color background of the solid type badge. */
  readonly typeColor = input('var(--color-section)');
  readonly selected = input(false);
  readonly expanded = input(false);
  /** 5-state dot status (`dotStatusFor`). */
  readonly dot = input.required<DotStatus>();
  /** Translated status label (also colors via the dot status). */
  readonly statusText = input('');
  /** Increment per received log line — drives the §8 orange flash. */
  readonly flashTick = input(0);
  readonly port = input<number | null>(null);
  /** Git badge counts (`git://badge`, §9). */
  readonly behind = input(0);
  readonly changes = input(0);
  readonly conflicts = input(0);
  /** Danger-env badge visible (§10). */
  readonly danger = input(false);
  /** Deps-missing warning visible (§6). */
  readonly depsWarning = input(false);
  /** Grey hint fragments, pre-joined (`headerHint`). */
  readonly hint = input('');
  /** §6 visibility/enable matrix (pre-computed via card-visibility.ts). */
  readonly vis = input.required<HeaderButtonVisibility>();
  readonly text = input.required<CardHeaderText>();

  readonly selectedChange = output<boolean>();
  readonly toggleExpand = output<void>();
  readonly start = output<void>();
  readonly stop = output<void>();
  readonly restart = output<void>();
  readonly openExplorer = output<void>();
  /** Open an interactive PTY terminal window rooted at the repo. */
  readonly openTerminal = output<void>();
  /** Right-click anywhere on the header — the container opens the menu. */
  readonly menuRequested = output<MouseEvent>();

  /** Space toggles like Enter but must not scroll the card list. */
  protected onSpaceToggle(event: Event): void {
    event.preventDefault();
    this.toggleExpand.emit();
  }
  readonly pullClicked = output<void>();
  readonly changesClicked = output<void>();
  readonly conflictsClicked = output<void>();

  protected onBadgeClick(
    event: MouseEvent,
    kind: 'pull' | 'changes' | 'conflicts',
  ): void {
    event.stopPropagation();
    if (kind === 'pull') {
      this.pullClicked.emit();
    } else if (kind === 'changes') {
      this.changesClicked.emit();
    } else {
      this.conflictsClicked.emit();
    }
  }
}

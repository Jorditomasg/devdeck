import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { IconButtonComponent } from '../icon-button/icon-button.component';
import { IconComponent } from '../icon/icon.component';
import { StatusDotComponent, type ServiceStatus } from '../status-dot/status-dot.component';

/** Already-translated labels/tooltips for one worktree row. */
export interface WorktreeRowText {
  readonly detached: string;
  readonly portTip: string;
  readonly portNotConfigurable: string;
  readonly changesTip: string;
  readonly start: string;
  readonly stop: string;
  readonly restart: string;
  readonly logs: string;
  readonly folder: string;
  readonly terminal: string;
  readonly history: string;
  readonly remove: string;
}

/**
 * One git worktree inside its parent repo card (git-worktrees design
 * 2026-10-12): branch, editable port, status and per-worktree actions.
 * Pure presentational — the container wires stores/IPC and translates.
 */
@Component({
  selector: 'ui-worktree-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconButtonComponent, IconComponent, StatusDotComponent],
  styleUrl: './worktree-row.component.scss',
  template: `
    <ui-status-dot [status]="status()" />
    <span class="wt__branch" [attr.title]="path()">
      <ui-icon name="git-branch" [size]="14" />
      {{ branch() ?? text().detached }}
    </span>
    @if (changes() > 0) {
      <span class="wt__changes" [attr.title]="text().changesTip">✎{{ changes() }}</span>
    }
    <input
      #portField
      class="wt__port"
      type="number"
      min="1"
      max="65535"
      [value]="port() ?? ''"
      [disabled]="!portConfigurable()"
      [attr.title]="portConfigurable() ? text().portTip : text().portNotConfigurable"
      (change)="emitPort(portField.value)"
    />
    <span class="wt__spacer"></span>
    @if (canStop()) {
      <ui-icon-button variant="danger" size="sm" [title]="text().stop" (clicked)="stop.emit()">
        <ui-icon name="square" [size]="14" />
      </ui-icon-button>
      <ui-icon-button size="sm" [title]="text().restart" (clicked)="restart.emit()">
        <ui-icon name="refresh" [size]="14" />
      </ui-icon-button>
    } @else {
      <ui-icon-button
        variant="start"
        size="sm"
        [disabled]="!canStart()"
        [title]="text().start"
        (clicked)="start.emit()"
      >
        <ui-icon name="play" [size]="14" />
      </ui-icon-button>
    }
    <ui-icon-button size="sm" [title]="text().logs" (clicked)="logs.emit()">
      <ui-icon name="file-text" [size]="14" />
    </ui-icon-button>
    <ui-icon-button size="sm" [title]="text().folder" (clicked)="folder.emit()">
      <ui-icon name="folder" [size]="14" />
    </ui-icon-button>
    <ui-icon-button size="sm" [title]="text().terminal" (clicked)="terminal.emit()">
      <ui-icon name="terminal" [size]="14" />
    </ui-icon-button>
    <ui-icon-button size="sm" [title]="text().history" (clicked)="history.emit()">
      <ui-icon name="history" [size]="14" />
    </ui-icon-button>
    <ui-icon-button variant="danger" size="sm" [title]="text().remove" (clicked)="remove.emit()">
      <ui-icon name="trash" [size]="14" />
    </ui-icon-button>
  `,
})
export class WorktreeRowComponent {
  /** Branch name; `null` = detached HEAD. */
  readonly branch = input<string | null>(null);
  readonly path = input('');
  readonly status = input<ServiceStatus>('stopped');
  readonly port = input<number | null>(null);
  /** The repo type declares `run.port_injection`. */
  readonly portConfigurable = input(true);
  readonly changes = input(0);
  readonly canStart = input(true);
  readonly canStop = input(false);
  readonly text = input.required<WorktreeRowText>();

  /** `null` = cleared; out-of-range input is ignored. */
  readonly portChange = output<number | null>();
  readonly start = output<void>();
  readonly stop = output<void>();
  readonly restart = output<void>();
  readonly logs = output<void>();
  readonly folder = output<void>();
  readonly terminal = output<void>();
  readonly history = output<void>();
  readonly remove = output<void>();

  protected emitPort(raw: string): void {
    if (raw.trim() === '') {
      this.portChange.emit(null);
      return;
    }
    const port = Number(raw);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      this.portChange.emit(port);
    }
  }
}

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { IconButtonComponent } from '../icon-button/icon-button.component';
import { IconComponent } from '../icon/icon.component';
import { StatusDotComponent, type ServiceStatus } from '../status-dot/status-dot.component';

export interface BranchTab {
  readonly id: string;
  readonly label: string;
  readonly status: ServiceStatus;
  readonly port: number | null;
  readonly changes: number;
}

export interface BranchTabsText {
  readonly add: string;
  readonly changes: string;
  readonly port: string;
  readonly portUnsupported: string;
  readonly remove: string;
}

/**
 * One tab per member of a repo family (the repo + its git worktrees). The
 * first tab is the repo itself; the port field and delete button only show
 * while a worktree tab is active.
 */
@Component({
  selector: 'ui-branch-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconButtonComponent, IconComponent, StatusDotComponent],
  styleUrl: './branch-tabs.component.scss',
  template: `
    <div class="tabs__list" role="tablist">
      @for (tab of tabs(); track tab.id) {
        <button
          type="button"
          role="tab"
          class="tab"
          [class.tab--active]="tab.id === active()"
          [attr.aria-selected]="tab.id === active()"
          (click)="selected.emit(tab.id)"
          (contextmenu)="onMenu($event, tab.id)"
        >
          <ui-status-dot [status]="tab.status" />
          <ui-icon name="git-branch" [size]="12" />
          <span class="tab__label">{{ tab.label }}</span>
          @if (tab.port; as p) {
            <span class="tab__port">:{{ p }}</span>
          }
          @if (tab.changes > 0) {
            <span class="tab__changes" [attr.title]="text().changes">✎{{ tab.changes }}</span>
          }
        </button>
      }
      <ui-icon-button size="sm" [title]="text().add" (clicked)="add.emit()">
        <ui-icon name="plus" [size]="14" />
      </ui-icon-button>
    </div>
    @if (worktreeActive()) {
      <input
        #portField
        class="tabs__port"
        type="number"
        min="1"
        max="65535"
        [value]="port() ?? ''"
        [disabled]="!portConfigurable()"
        [attr.title]="portConfigurable() ? text().port : text().portUnsupported"
        (change)="emitPort(portField.value)"
      />
      <ui-icon-button variant="danger" size="sm" [title]="text().remove" (clicked)="remove.emit()">
        <ui-icon name="trash" [size]="14" />
      </ui-icon-button>
    }
  `,
})
export class BranchTabsComponent {
  readonly tabs = input.required<readonly BranchTab[]>();
  readonly active = input.required<string>();
  /** Active tab is a worktree (not the repo itself). */
  readonly worktreeActive = input(false);
  readonly port = input<number | null>(null);
  readonly portConfigurable = input(true);
  readonly text = input.required<BranchTabsText>();

  readonly selected = output<string>();
  readonly menuRequested = output<{ id: string; event: MouseEvent }>();
  readonly add = output<void>();
  /** `null` = cleared; out-of-range input is ignored. */
  readonly portChange = output<number | null>();
  readonly remove = output<void>();

  protected onMenu(event: MouseEvent, id: string): void {
    event.preventDefault();
    this.menuRequested.emit({ id, event });
  }

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

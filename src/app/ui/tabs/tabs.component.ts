import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';

/** One tab in a `ui-tabs` bar — `label` arrives already translated. */
export interface TabDef {
  readonly id: string;
  readonly label: string;
}

/**
 * Underlined tab bar — switches a container's panels. Pure presentational: the
 * container owns the active-id signal (two-way bound) and renders the panel
 * bodies itself (e.g. with `@switch`). Labels are pre-translated by the
 * container, keeping `ui/` free of the i18n runtime.
 */
@Component({
  selector: 'ui-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './tabs.component.scss',
  template: `
    <div class="tabs" role="tablist">
      @for (tab of tabs(); track tab.id) {
        <button
          type="button"
          role="tab"
          class="tabs__tab"
          [class.tabs__tab--active]="tab.id === active()"
          [attr.aria-selected]="tab.id === active()"
          (click)="active.set(tab.id)"
        >
          {{ tab.label }}
        </button>
      }
    </div>
  `,
})
export class TabsComponent {
  readonly tabs = input.required<readonly TabDef[]>();
  /** Active tab id (two-way bound). */
  readonly active = model.required<string>();
}

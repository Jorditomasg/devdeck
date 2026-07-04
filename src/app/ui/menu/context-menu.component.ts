import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  output,
  signal,
} from '@angular/core';
import { IconComponent } from '../icon/icon.component';
import { nextEnabledIndex } from './context-menu.logic';
import type { MenuEntry } from './context-menu.types';

/**
 * Context-menu overlay panel — created imperatively by `ContextMenuService`
 * (never placed in a template), body-appended and `position: fixed` so it
 * escapes overflow-clipped ancestors, exactly like the tooltip overlay.
 *
 * Purely presentational: renders entries, tracks the keyboard-active row and
 * emits `picked`/`dismissed`. Positioning/clamping and document-level
 * dismissal listeners are the SERVICE's job.
 */
@Component({
  selector: 'ui-context-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  styleUrl: './context-menu.component.scss',
  host: {
    role: 'menu',
    tabindex: '-1',
    '[style.left.px]': 'x()',
    '[style.top.px]': 'y()',
    '[style.visibility]': "measured() ? 'visible' : 'hidden'",
    '(keydown)': 'onKeydown($event)',
    // A right-click ON the menu itself must not spawn a nested native menu.
    '(contextmenu)': '$event.preventDefault()',
  },
  template: `
    @for (item of items(); track item.id; let i = $index) {
      @if (item.separator) {
        <div class="menu__sep" role="separator"></div>
      }
      <button
        type="button"
        role="menuitem"
        class="menu__item"
        [class.menu__item--danger]="item.danger"
        [class.menu__item--active]="i === activeIndex()"
        [disabled]="item.disabled"
        (mouseenter)="activeIndex.set(i)"
        (click)="pick(item)"
      >
        <span class="menu__icon">
          @if (item.icon; as icon) {
            <ui-icon [name]="icon" [size]="14" />
          }
        </span>
        <span class="menu__label">{{ item.label }}</span>
        @if (item.hint) {
          <span class="menu__hint">{{ item.hint }}</span>
        }
      </button>
    }
  `,
})
export class ContextMenuComponent {
  readonly items = signal<readonly MenuEntry[]>([]);
  readonly x = signal(0);
  readonly y = signal(0);
  readonly measured = signal(false);

  readonly picked = output<string>();
  readonly dismissed = output<void>();

  protected readonly activeIndex = signal(-1);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  focusPanel(): void {
    this.host.nativeElement.focus();
  }

  protected pick(item: MenuEntry): void {
    if (item.disabled) return;
    this.picked.emit(item.id);
  }

  protected onKeydown(ev: KeyboardEvent): void {
    switch (ev.key) {
      case 'Escape':
        ev.stopPropagation();
        this.dismissed.emit();
        break;
      case 'ArrowDown':
      case 'ArrowUp': {
        ev.preventDefault();
        const delta = ev.key === 'ArrowDown' ? 1 : -1;
        this.activeIndex.set(nextEnabledIndex(this.items(), this.activeIndex(), delta));
        break;
      }
      case 'Enter':
      case ' ': {
        ev.preventDefault();
        const item = this.items()[this.activeIndex()];
        if (item) this.pick(item);
        break;
      }
    }
  }

}

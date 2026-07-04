import {
  ApplicationRef,
  ComponentRef,
  EnvironmentInjector,
  Injectable,
  createComponent,
  inject,
} from '@angular/core';
import { TooltipDirective } from '../tooltip/tooltip.directive';
import { ContextMenuComponent } from './context-menu.component';
import { clampMenuPosition } from './context-menu.logic';
import type { MenuEntry } from './context-menu.types';

/** Minimum gap kept from every viewport edge when clamping (as tooltip). */
const VIEWPORT_MARGIN = 4;

/**
 * Imperative context-menu opener — the app-wide right-click primitive.
 *
 * Lives in `ui/` (imports nothing from `core`); containers inject it, build
 * pre-translated `MenuEntry[]` lists and switch on the resolved id:
 *
 * ```ts
 * protected async onContextMenu(ev: MouseEvent): Promise<void> {
 *   const picked = await this.menu.openFromEvent(ev, [
 *     { id: 'copy', label: this.i18n.t('menu.copy_path'), icon: 'copy' },
 *     { id: 'delete', label: this.i18n.t('btn.delete'), icon: 'trash', danger: true },
 *   ]);
 *   if (picked === 'copy') { … }
 * }
 * ```
 *
 * One menu at a time: opening a new one dismisses the previous (resolving it
 * with `null`). Dismissal: outside mousedown, Escape, window blur/resize,
 * right-click elsewhere. Positioning mirrors the tooltip overlay: body-append,
 * `position: fixed`, measure on the next frame, flip when overflowing the
 * bottom/right viewport edge, clamp to the margins.
 */
@Injectable({ providedIn: 'root' })
export class ContextMenuService {
  private readonly appRef = inject(ApplicationRef);
  private readonly injector = inject(EnvironmentInjector);

  private ref: ComponentRef<ContextMenuComponent> | null = null;
  private resolve: ((id: string | null) => void) | null = null;

  /** `preventDefault` + `stopPropagation` + open at the pointer position. */
  openFromEvent(ev: MouseEvent, items: readonly MenuEntry[]): Promise<string | null> {
    ev.preventDefault();
    ev.stopPropagation();
    return this.open(ev.clientX, ev.clientY, items);
  }

  /** Open at viewport coordinates; resolves with the picked id or `null`. */
  open(x: number, y: number, items: readonly MenuEntry[]): Promise<string | null> {
    this.dismiss();
    if (!items.length) return Promise.resolve(null);
    TooltipDirective.hideAll();

    const ref = createComponent(ContextMenuComponent, { environmentInjector: this.injector });
    this.ref = ref;
    this.appRef.attachView(ref.hostView);
    const el = ref.location.nativeElement as HTMLElement;
    document.body.appendChild(el);

    ref.instance.items.set(items);
    ref.instance.x.set(x);
    ref.instance.y.set(y);
    ref.instance.picked.subscribe((id: string) => this.settle(id));
    ref.instance.dismissed.subscribe(() => this.dismiss());

    // Measure after first paint, then flip/clamp into the viewport.
    requestAnimationFrame(() => {
      if (this.ref !== ref) return; // dismissed meanwhile
      const { offsetWidth: w, offsetHeight: h } = el;
      const pos = clampMenuPosition(
        x,
        y,
        w,
        h,
        window.innerWidth,
        window.innerHeight,
        VIEWPORT_MARGIN,
      );
      ref.instance.x.set(pos.x);
      ref.instance.y.set(pos.y);
      ref.instance.measured.set(true);
      ref.instance.focusPanel();
    });

    document.addEventListener('mousedown', this.onDocMousedown, true);
    document.addEventListener('contextmenu', this.onDocContextMenu, true);
    window.addEventListener('blur', this.onWindowBlur);
    window.addEventListener('resize', this.onWindowBlur);

    return new Promise<string | null>((resolve) => {
      this.resolve = resolve;
    });
  }

  /** Close the open menu (if any), resolving its promise with `null`. */
  dismiss(): void {
    this.settle(null);
  }

  private settle(id: string | null): void {
    document.removeEventListener('mousedown', this.onDocMousedown, true);
    document.removeEventListener('contextmenu', this.onDocContextMenu, true);
    window.removeEventListener('blur', this.onWindowBlur);
    window.removeEventListener('resize', this.onWindowBlur);
    this.ref?.destroy();
    this.ref = null;
    this.resolve?.(id);
    this.resolve = null;
  }

  private readonly onDocMousedown = (ev: MouseEvent): void => {
    const el = this.ref?.location.nativeElement as HTMLElement | undefined;
    if (el && !el.contains(ev.target as Node)) this.dismiss();
  };

  // A second right-click outside closes the menu AND lets the new target's
  // own (contextmenu) handler run (capture phase, no preventDefault here).
  private readonly onDocContextMenu = (ev: MouseEvent): void => {
    const el = this.ref?.location.nativeElement as HTMLElement | undefined;
    if (el && !el.contains(ev.target as Node)) this.dismiss();
  };

  private readonly onWindowBlur = (): void => {
    this.dismiss();
  };
}

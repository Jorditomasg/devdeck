import {
  ComponentRef,
  DestroyRef,
  Directive,
  ElementRef,
  ViewContainerRef,
  effect,
  inject,
  input,
} from '@angular/core';
import { TooltipOverlayComponent } from './tooltip-overlay.component';

/** v1 ToolTip offsets from the widget's top-left corner (inventory-gui §31). */
const OFFSET_X = 12;
const OFFSET_Y = 4;
/** Minimum gap kept from every viewport edge when clamping. */
const VIEWPORT_MARGIN = 4;
/** Fallback when --tooltip-delay cannot be read (matches the token: 500ms). */
const DEFAULT_DELAY_MS = 500;

/** Parse a CSS time value like "500ms" / "0.5s" into milliseconds. */
export function parseCssTimeMs(raw: string, fallback: number): number {
  const value = raw.trim();
  if (!value) return fallback;
  const num = Number.parseFloat(value);
  if (Number.isNaN(num)) return fallback;
  return value.endsWith('ms') ? num : value.endsWith('s') ? num * 1000 : num;
}

/**
 * Hover tooltip — replaces the v1 `ToolTip` widget (inventory-gui §31):
 *
 * - Shows after the `--tooltip-delay` token (500ms); canceled by leave /
 *   mousedown before the timer fires.
 * - Positioned below the host, +12px x / +4px y from the host's corner,
 *   then smart-clamped to the viewport (flips above when it would overflow
 *   the bottom edge, clamps horizontally).
 * - Wrap width comes from `--tooltip-wrap` (overlay SCSS).
 * - Empty text cancels any pending/visible tip; text changes update a
 *   visible tip live (v1 `update_text`).
 * - `TooltipDirective.hideAll()` replaces v1's grab interaction: call it when
 *   a modal opens or the window hides to tray, since `mouseleave` may never
 *   arrive (the dialog-shell does this on open).
 *
 * ```html
 * <ui-icon-button [uiTooltip]="t('tooltip.start_btn')" …/>
 * ```
 */
@Directive({
  selector: '[uiTooltip]',
  host: {
    '(mouseenter)': 'onEnter()',
    '(mouseleave)': 'cancel()',
    '(mousedown)': 'cancel()',
  },
})
export class TooltipDirective {
  /** Tooltip text (already translated). Empty string disables the tooltip. */
  readonly uiTooltip = input('');

  private static readonly active = new Set<TooltipDirective>();

  /** Hide every pending/visible tooltip (modal opened / window hidden). */
  static hideAll(): void {
    for (const tip of TooltipDirective.active) tip.cancel();
  }

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly vcr = inject(ViewContainerRef);

  private overlayRef: ComponentRef<TooltipOverlayComponent> | null = null;
  private showTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancel());

    // v1 update_text: live-update a visible tip; empty text cancels it.
    effect(() => {
      const text = this.uiTooltip();
      if (!text) {
        this.cancel();
      } else {
        this.overlayRef?.instance.text.set(text);
      }
    });
  }

  protected onEnter(): void {
    if (!this.uiTooltip()) return;
    clearTimeout(this.showTimer);
    this.showTimer = setTimeout(() => this.show(), this.readDelayMs());
    TooltipDirective.active.add(this);
  }

  /** Cancel a pending tip and/or destroy a visible one. */
  cancel(): void {
    clearTimeout(this.showTimer);
    this.showTimer = undefined;
    this.overlayRef?.destroy();
    this.overlayRef = null;
    TooltipDirective.active.delete(this);
  }

  private show(): void {
    if (this.overlayRef || !this.uiTooltip()) return;

    const ref = this.vcr.createComponent(TooltipOverlayComponent);
    this.overlayRef = ref;
    const el = ref.location.nativeElement as HTMLElement;
    document.body.appendChild(el);

    ref.instance.text.set(this.uiTooltip());
    const rect = this.host.nativeElement.getBoundingClientRect();
    ref.instance.x.set(rect.left + OFFSET_X);
    ref.instance.y.set(rect.bottom + OFFSET_Y);

    // Measure after first paint, then clamp/flip into the viewport.
    requestAnimationFrame(() => {
      if (this.overlayRef !== ref) return; // canceled meanwhile
      const { offsetWidth: w, offsetHeight: h } = el;
      let x = rect.left + OFFSET_X;
      let y = rect.bottom + OFFSET_Y;
      if (y + h > window.innerHeight - VIEWPORT_MARGIN) {
        y = rect.top - h - OFFSET_Y; // flip above
      }
      x = Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - w - VIEWPORT_MARGIN));
      y = Math.max(VIEWPORT_MARGIN, y);
      ref.instance.x.set(x);
      ref.instance.y.set(y);
      ref.instance.measured.set(true);
    });
  }

  private readDelayMs(): number {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--tooltip-delay');
    return parseCssTimeMs(raw, DEFAULT_DELAY_MS);
  }
}

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TooltipDirective } from '../tooltip/tooltip.directive';

const CASCADE_OFFSET_PX = 20; // v1 _CASCADE_OFFSET_PX (§13.4)
const KNOCK_DURATION_MS = 360;
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Reusable modal shell — replaces v1 `BaseDialog` (inventory-gui §13):
 *
 * - **CSS backdrop at 50% darken** replaces the PIL screenshot overlay hack
 *   (§13.3 — `_OVERLAY_DARKEN = 0.5`).
 * - **Centered + cascade**: each nesting level offsets the panel +20px x/y
 *   (§13.4) — pass `cascadeLevel` = how many dialogs are already open.
 * - **Blocked-click "knock"** (§13.7): clicking the backdrop while
 *   `closeOnBackdrop` is false plays a subtle shake + border flash instead
 *   of closing — the v2 equivalent of v1's `bell()` + lift. Also exposed as
 *   a public `knock()` method for programmatic blocked-interaction feedback.
 * - **Focus trap**: initial focus on the panel, Tab/Shift+Tab cycle within.
 * - **ESC** closes when `closeOnEscape` (default true, v1 WM close).
 * - Opens by hiding all tooltips (v1 `ToolTip.hide_all()` on grab, §13.6).
 *
 * Purely presentational: it never closes itself — it emits `closed` and the
 * container removes it (`@if`). Title text arrives already translated.
 * Footer buttons project via the `[uiDialogFooter]` slot (the v1 button row).
 *
 * ```html
 * @if (settingsOpen()) {
 *   <ui-dialog-shell [dialogTitle]="t('dialog.settings.title')" width="580px"
 *                    (closed)="settingsOpen.set(false)">
 *     …content…
 *     <div uiDialogFooter>
 *       <ui-button variant="neutral" (clicked)="…">{{ t('btn.cancel') }}</ui-button>
 *     </div>
 *   </ui-dialog-shell>
 * }
 * ```
 */
@Component({
  selector: 'ui-dialog-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dialog-shell.component.html',
  styleUrl: './dialog-shell.component.scss',
})
export class DialogShellComponent {
  /** Header title (already translated). */
  readonly dialogTitle = input('');
  /** CSS width of the panel (e.g. '500px'); height grows with content. */
  readonly width = input('auto');
  /** Nesting depth: offsets the panel +20px x/y per level (§13.4). */
  readonly cascadeLevel = input(0);
  /** ESC requests close (default true). */
  readonly closeOnEscape = input(true);
  /** Backdrop click closes (default false → "knock" feedback, §13.7). */
  readonly closeOnBackdrop = input(false);
  /** Show the header ✕ button. */
  readonly showClose = input(true);
  /** User requested close (ESC / ✕ / backdrop). Container removes the dialog. */
  readonly closed = output<void>();

  protected readonly knocking = signal(false);
  protected readonly offset = (): number => this.cascadeLevel() * CASCADE_OFFSET_PX;

  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');
  private knockTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // v1: grab_set hides every open tooltip — mouseleave never arrives (§13.6).
    TooltipDirective.hideAll();
    afterNextRender(() => this.panel().nativeElement.focus());
    inject(DestroyRef).onDestroy(() => clearTimeout(this.knockTimer));
  }

  /** Blocked-interaction feedback: subtle shake + border flash (§13.7). */
  knock(): void {
    this.knocking.set(false);
    clearTimeout(this.knockTimer);
    // Restart the CSS animation on the next frame even if mid-knock.
    requestAnimationFrame(() => this.knocking.set(true));
    this.knockTimer = setTimeout(() => this.knocking.set(false), KNOCK_DURATION_MS);
  }

  protected onBackdropMousedown(ev: MouseEvent): void {
    if (ev.target !== ev.currentTarget) return; // click was inside the panel
    if (this.closeOnBackdrop()) {
      this.closed.emit();
    } else {
      this.knock();
    }
  }

  protected onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.closeOnEscape()) {
      ev.stopPropagation();
      this.closed.emit();
      return;
    }
    if (ev.key === 'Tab') this.trapTab(ev);
  }

  /** Keep Tab/Shift+Tab cycling inside the panel (focus trap). */
  private trapTab(ev: KeyboardEvent): void {
    const focusables = this.panel().nativeElement.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (focusables.length === 0) {
      ev.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (ev.shiftKey && (active === first || active === this.panel().nativeElement)) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  }
}

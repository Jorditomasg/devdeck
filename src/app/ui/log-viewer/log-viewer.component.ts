import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { IconComponent } from '../icon/icon.component';
import { DEFAULT_MAX_LINES, capLines, isNearBottom } from './log-viewer.logic';

/**
 * High-performance read-only log panel — replaces the v1 card/global/detached
 * log textboxes (inventory-gui §5, §8; `theme.log_textbox_style()` §29):
 * mono sm font, app background, card border, timestamped plain-text lines
 * (ANSI is stripped Rust-side per architecture §3.2), text selection enabled.
 *
 * Inputs are presentational only: the container owns the buffers, timestamps
 * and the clear/detach/flash actions (those buttons live in the organism
 * header, not here — §8).
 *
 * Performance strategy (thousands of lines without jank):
 * 1. **Hard line cap** (`maxLines`, v1 default 500): `capLines()` keeps only
 *    the newest N — the same trim rule as v1's `count_ref` head-trim.
 * 2. **Stable track keys**: each line is tracked by its absolute line number
 *    (`startIndex + dropped + i`), so a head-trim destroys only the removed
 *    nodes instead of re-creating the whole list.
 * 3. **`content-visibility: auto`** + `contain-intrinsic-size` per line:
 *    offscreen lines skip layout/paint entirely, so even a full 500-line
 *    panel costs roughly one viewport of rendering work.
 *    A virtual window was rejected: with a 500-line cap it adds complexity
 *    (breaks Ctrl+F-style selection and native scrolling) for no measurable
 *    win — content-visibility gives the same paint savings.
 * 4. **Autoscroll-unless-scrolled-up**: stickiness is tracked from scroll
 *    events (`isNearBottom`), re-applied after each render only while stuck.
 *
 * Containers should batch line appends (the IPC bridge already flushes every
 * ~50-100ms — architecture §3.2) so this component re-renders at most ~20x/s.
 */
@Component({
  selector: 'ui-log-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './log-viewer.component.scss',
  imports: [IconComponent],
  template: `
    <div #scroller class="log" (scroll)="onScroll()">
      @for (line of view().lines; track base() + $index) {
        <div class="log__line">{{ line }}</div>
      } @empty {
        <div class="log__empty">{{ emptyText() }}</div>
      }
    </div>
    @if (!stick()) {
      <button
        type="button"
        class="log__jump"
        [attr.aria-label]="jumpToBottomLabel()"
        [attr.title]="jumpToBottomLabel()"
        (click)="scrollToBottom()"
      >
        <ui-icon name="arrow-down-to-line" [size]="16" />
      </button>
    }
  `,
})
export class LogViewerComponent {
  /**
   * Readonly array of plain-text lines (timestamped + ANSI-stripped
   * upstream). Replace the array reference to append — signal semantics.
   */
  readonly lines = input<readonly string[]>([]);
  /** Render cap; oldest lines beyond it are dropped (v1 LOG_MAX_LINES=500). */
  readonly maxLines = input(DEFAULT_MAX_LINES);
  /**
   * Count of lines the CONTAINER already trimmed from the head of `lines`.
   * Keeps absolute line numbers (track keys) stable across store-side trims.
   */
  readonly startIndex = input(0);
  /** Master switch for stick-to-bottom autoscroll. */
  readonly autoScroll = input(true);
  /** Placeholder when there are no lines yet (already translated). */
  readonly emptyText = input('');
  /**
   * Aria-label/tooltip for the jump-to-bottom button (already translated).
   * The button surfaces only while the user has scrolled up off the bottom.
   */
  readonly jumpToBottomLabel = input('');

  protected readonly view = computed(() => capLines(this.lines(), this.maxLines()));
  /** First rendered line's absolute number — the stable track-key base. */
  protected readonly base = computed(() => this.startIndex() + this.view().dropped);

  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');
  /**
   * True while the user is at (or near) the bottom — autoscroll engaged.
   * When false the jump-to-bottom button appears (there is content below).
   */
  protected readonly stick = signal(true);

  constructor() {
    // Re-pin to the bottom after every render while stickiness is engaged.
    // No programmatic-scroll guard is needed: pinning lands at the bottom,
    // so the resulting scroll event recomputes stickiness as `true`.
    afterRenderEffect(() => {
      this.view(); // re-run on new lines
      if (!this.autoScroll() || !this.stick()) return;
      const el = this.scroller().nativeElement;
      el.scrollTop = el.scrollHeight;
    });
  }

  /** Scroll: disengage when leaving the bottom, re-engage on return. */
  protected onScroll(): void {
    const el = this.scroller().nativeElement;
    this.stick.set(isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight));
  }

  /** Jump to the newest line and re-engage autoscroll. */
  protected scrollToBottom(): void {
    const el = this.scroller().nativeElement;
    el.scrollTop = el.scrollHeight;
    this.stick.set(true);
  }
}

import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';

import { pageCount as computePageCount } from './pagination.logic';

/**
 * Compact previous/next pager — `‹ {page} / {total} ›`. Pure presentational:
 * the container owns the item list and the page signal; this only clamps and
 * emits. Renders nothing when there is a single page (or none).
 *
 * Labels arrive already translated (containers pass `prevLabel`/`nextLabel`),
 * keeping `ui/` free of the i18n runtime.
 */
@Component({
  selector: 'ui-pagination',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './pagination.component.scss',
  template: `
    @if (pageCount() > 1) {
      <nav class="pager">
        <button
          type="button"
          class="pager__btn"
          [disabled]="page() <= 1"
          [attr.aria-label]="prevLabel()"
          [attr.title]="prevLabel()"
          (click)="go(page() - 1)"
        >
          ‹
        </button>
        <span class="pager__status">{{ page() }} / {{ pageCount() }}</span>
        <button
          type="button"
          class="pager__btn"
          [disabled]="page() >= pageCount()"
          [attr.aria-label]="nextLabel()"
          [attr.title]="nextLabel()"
          (click)="go(page() + 1)"
        >
          ›
        </button>
      </nav>
    }
  `,
})
export class PaginationComponent {
  /** Current 1-based page (two-way bound). */
  readonly page = model.required<number>();
  /** Total number of items being paged. */
  readonly total = input.required<number>();
  /** Items per page. */
  readonly pageSize = input.required<number>();
  /** Pre-translated accessible labels for the arrows. */
  readonly prevLabel = input('');
  readonly nextLabel = input('');

  protected readonly pageCount = computed(() => computePageCount(this.total(), this.pageSize()));

  protected go(next: number): void {
    this.page.set(Math.min(Math.max(1, next), this.pageCount()));
  }
}

import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  TemplateRef,
  ViewEncapsulation,
  computed,
  contentChild,
  inject,
  input,
  signal,
} from '@angular/core';
import { PaginationComponent } from '../pagination/pagination.component';
import { clampPage, pageSlice } from '../pagination/pagination.logic';

/** Marks the `<tr>` template rendered inside `<thead>`. */
@Directive({ selector: '[uiTableHead]' })
export class TableHeadDirective {
  readonly template = inject(TemplateRef);
}

/** Marks the per-item `<tr>` template (`let-item` = the row's item). */
@Directive({ selector: '[uiTableRow]' })
export class TableRowDirective<T> {
  readonly template = inject<TemplateRef<{ $implicit: T }>>(TemplateRef);

  /** Lets `let-item` receive the `items` element type in strict templates. */
  static ngTemplateContextGuard<T>(
    _dir: TableRowDirective<T>,
    _ctx: unknown,
  ): _ctx is { $implicit: T } {
    return true;
  }
}

/**
 * Searchable, paginated data table — the ONE table primitive for dialog
 * tables (branches, stashes). Owns the live filter, the "no results" state
 * and the page clamping so every table behaves identically; consumers only
 * project the header and row templates:
 *
 * ```html
 * <ui-filter-table [items]="branches()" [haystack]="identity" [pageSize]="15" …>
 *   <tr *uiTableHead><th>…</th></tr>
 *   <tr *uiTableRow="let b" (contextmenu)="onRowMenu($event, b)">…</tr>
 * </ui-filter-table>
 * ```
 *
 * All labels arrive pre-translated (ui-kit rule). The empty-LIST state stays
 * in the container (it usually replaces the whole table); this component owns
 * the empty-RESULTS state (filter matched nothing).
 */
@Component({
  selector: 'ui-filter-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, PaginationComponent],
  styleUrl: './filter-table.component.scss',
  // The head/row <tr>s are outlet-rendered TEMPLATES from the consumer, so
  // they carry the CONSUMER's encapsulation attribute — emulated-scoped
  // `.ft__table th` rules would never match them. Encapsulation off; every
  // selector is `.ft__`-prefixed (and `ui-filter-table`-scoped), so nothing
  // leaks.
  encapsulation: ViewEncapsulation.None,
  template: `
    @if (searchable()) {
      <input
        #search
        class="ft__search"
        type="search"
        [placeholder]="searchPlaceholder()"
        [value]="filter()"
        (input)="onFilter(search.value)"
      />
    }
    @if (filtered().length === 0) {
      <p class="ft__no-results">{{ noResultsText() }}</p>
    } @else {
      <div class="ft__wrap">
        <table class="ft__table">
          <thead>
            <ng-container [ngTemplateOutlet]="head().template" />
          </thead>
          <tbody>
            @for (item of visible(); track trackBy()(item)) {
              <ng-container
                [ngTemplateOutlet]="row().template"
                [ngTemplateOutletContext]="{ $implicit: item }"
              />
            }
          </tbody>
        </table>
      </div>
      <ui-pagination
        [page]="currentPage()"
        (pageChange)="page.set($event)"
        [total]="filtered().length"
        [pageSize]="pageSize()"
        [prevLabel]="prevLabel()"
        [nextLabel]="nextLabel()"
      />
    }
  `,
})
export class FilterTableComponent<T> {
  /** Full (unfiltered) item list; the container keeps its own empty state. */
  readonly items = input.required<readonly T[]>();
  /** Hide the search input for short lists (java versions, profiles). */
  readonly searchable = input(true);
  /** Text an item is searched by (e.g. the branch name, the stash label). */
  readonly haystack = input<(item: T) => string>(() => '');
  readonly pageSize = input.required<number>();
  /** Row identity for `@for` tracking (defaults to the item itself). */
  readonly trackBy = input<(item: T) => unknown>((item) => item);
  /** Pre-translated texts. */
  readonly searchPlaceholder = input('');
  readonly noResultsText = input('');
  readonly prevLabel = input('');
  readonly nextLabel = input('');

  protected readonly head = contentChild.required(TableHeadDirective);
  protected readonly row = contentChild.required<TableRowDirective<T>>(TableRowDirective);

  protected readonly filter = signal('');
  protected readonly page = signal(1);

  protected readonly filtered = computed(() => {
    const query = this.filter().trim().toLowerCase();
    if (!query) {
      return this.items();
    }
    const haystack = this.haystack();
    return this.items().filter((item) => haystack(item).toLowerCase().includes(query));
  });

  /** Clamped on read, so list shrinkage (drop/pop/delete) self-heals. */
  protected readonly currentPage = computed(() =>
    clampPage(this.page(), this.filtered().length, this.pageSize()),
  );

  protected readonly visible = computed(() =>
    pageSlice(this.filtered(), this.currentPage(), this.pageSize()),
  );

  /** Filter change resets paging (the page count just changed). */
  protected onFilter(value: string): void {
    this.filter.set(value);
    this.page.set(1);
  }
}

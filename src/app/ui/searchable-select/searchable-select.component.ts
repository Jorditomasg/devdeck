import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  FILTER_DEBOUNCE_MS,
  PAGE_SIZE,
  filterOptions,
  moveActiveIndex,
  nextRenderCount,
  separatorIndex,
  shouldLoadMore,
} from './searchable-select.logic';

/**
 * Searchable dropdown — replaces the v1 `SearchableCombo` widget
 * (inventory-gui §32). Used for branches, env configs, java versions,
 * profiles, groups, languages and merge selectors.
 *
 * Behavior parity:
 * - Collapsed display: ellipsized value + ▾ arrow; disabled greys the label;
 *   native title carries the full text while truncated.
 * - Popup: auto-focused live-filter input, **150ms debounce**, case-insensitive
 *   substring; "no results" placeholder text via input.
 * - Infinite scroll: first 30 rendered, +30 whenever scrolled ≥98.5% down;
 *   appending preserves scroll position.
 * - Max ~9 visible rows, then the list scrolls.
 * - Optional recents divider after the first `recentCount` items — only on
 *   the unfiltered list.
 * - Dismissal: Escape, click outside, host destroy.
 * - Live refresh: changing `options`/`recentCount` while open re-renders in
 *   place (async branch loads).
 *
 * **Change semantics (load-bearing, §32 API):** `selectionChange` (and the
 * `value` model's `valueChange`) fire ONLY on user selection. A programmatic
 * write through the `[value]` binding never emits — exactly like v1's
 * `set()`, which profile-apply and merge-dialog default-tracking rely on.
 *
 * v2 addition over v1 parity: ArrowUp/ArrowDown/Enter keyboard navigation
 * (the inventory explicitly allows Angular to add it).
 */
@Component({
  selector: 'ui-searchable-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './searchable-select.component.html',
  styleUrl: './searchable-select.component.scss',
})
export class SearchableSelectComponent {
  /** Full option list, already ordered (recents first when applicable). */
  readonly options = input<readonly string[]>([]);
  /**
   * Selected value. Programmatic writes via `[value]` NEVER emit — only a
   * user pick fires `valueChange`/`selectionChange`.
   */
  readonly value = model('');
  /** Recents divider drawn after the first N items (0 = none) — §32. */
  readonly recentCount = input(0);
  /** Shown (muted) when no value is selected. */
  readonly placeholder = input('');
  /** Search input placeholder (v1 `placeholder.search`). */
  readonly searchPlaceholder = input('');
  /** Empty-filter text (v1 `placeholder.no_results`). */
  readonly noResultsText = input('');
  readonly disabled = input(false);
  /** Fired ONLY on user selection (never on programmatic `value` writes). */
  readonly selectionChange = output<string>();

  protected readonly open = signal(false);
  protected readonly debouncedQuery = signal('');
  protected readonly renderCount = signal(PAGE_SIZE);
  protected readonly activeIndex = signal(-1);

  protected readonly filtered = computed(() => filterOptions(this.options(), this.debouncedQuery()));
  protected readonly visible = computed(() => this.filtered().slice(0, this.renderCount()));
  protected readonly hasMore = computed(() => this.filtered().length > this.renderCount());
  protected readonly dividerAfter = computed(() =>
    separatorIndex(this.recentCount(), this.debouncedQuery().trim().length > 0, this.filtered().length),
  );

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  private readonly listEl = viewChild<ElementRef<HTMLElement>>('list');

  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onDocMousedown = (ev: MouseEvent): void => {
    if (!this.host.nativeElement.contains(ev.target as Node)) this.close();
  };

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.debounceTimer);
      document.removeEventListener('mousedown', this.onDocMousedown);
    });

    // Auto-focus the search input when the popup opens (§32) and keep the
    // active row scrolled into view during keyboard navigation.
    afterRenderEffect(() => {
      if (this.open()) this.searchInput()?.nativeElement.focus();
      const idx = this.activeIndex();
      if (idx >= 0) {
        this.listEl()
          ?.nativeElement.querySelector(`[data-index="${idx}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  protected toggle(): void {
    if (this.disabled()) return;
    this.open() ? this.close() : this.openPopup();
  }

  protected openPopup(): void {
    this.debouncedQuery.set('');
    this.renderCount.set(PAGE_SIZE);
    this.activeIndex.set(-1);
    this.open.set(true);
    document.addEventListener('mousedown', this.onDocMousedown);
  }

  protected close(): void {
    if (!this.open()) return;
    this.open.set(false);
    document.removeEventListener('mousedown', this.onDocMousedown);
  }

  /** 150ms-debounced live filter (§32). Resets paging and active row. */
  protected onSearch(raw: string): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debouncedQuery.set(raw);
      this.renderCount.set(PAGE_SIZE);
      this.activeIndex.set(-1);
    }, FILTER_DEBOUNCE_MS);
  }

  /** +30 items when scrolled ≥98.5% down; scroll position is preserved. */
  protected onListScroll(): void {
    const el = this.listEl()?.nativeElement;
    if (!el || !this.hasMore()) return;
    if (shouldLoadMore(el.scrollTop, el.clientHeight, el.scrollHeight)) {
      this.renderCount.set(nextRenderCount(this.renderCount(), this.filtered().length));
    }
  }

  protected onKeydown(ev: KeyboardEvent): void {
    switch (ev.key) {
      case 'Escape':
        ev.stopPropagation();
        this.close();
        break;
      case 'ArrowDown':
      case 'ArrowUp': {
        ev.preventDefault();
        const delta = ev.key === 'ArrowDown' ? 1 : -1;
        this.activeIndex.set(moveActiveIndex(this.activeIndex(), delta, this.visible().length));
        break;
      }
      case 'Enter': {
        ev.preventDefault();
        const option = this.visible()[this.activeIndex()];
        if (option !== undefined) this.select(option);
        break;
      }
    }
  }

  /** User selection — the ONLY path that emits (§32 `set()` contract). */
  protected select(option: string): void {
    this.value.set(option);
    this.selectionChange.emit(option);
    this.close();
  }
}

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { parseDiffLines } from './diff-lines';

/**
 * Unified diff renderer (git suite phase 1): typed rows with ± coloring and
 * old/new line-number gutters. Receives raw `git diff` text — parsing lives
 * in `diff-lines.ts` (pure, tested). Pure presentational: no core imports;
 * empty-state text arrives translated via `emptyText`.
 */
@Component({
  selector: 'ui-diff-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './diff-view.component.scss',
  template: `
    @if (rows().length === 0) {
      <div class="diff__empty">{{ emptyText() }}</div>
    } @else {
      <div class="diff__scroll">
        <table class="diff__table">
          <tbody>
            @for (row of rows(); track $index) {
              <tr class="diff__row" [class]="'diff__row--' + row.kind">
                <td class="diff__no">{{ row.oldNo ?? '' }}</td>
                <td class="diff__no">{{ row.newNo ?? '' }}</td>
                <td class="diff__sign">{{ sign(row.kind) }}</td>
                <td class="diff__text">{{ row.text }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class DiffViewComponent {
  /** Raw unified diff text (one file). */
  readonly diff = input('');
  /** Already-translated text shown when the diff is empty. */
  readonly emptyText = input('');

  protected readonly rows = computed(() => parseDiffLines(this.diff()));

  protected sign(kind: string): string {
    return kind === 'add' ? '+' : kind === 'del' ? '-' : '';
  }
}

import type { IconName } from '../icon/icon.component';

/**
 * One entry of a context menu. Labels arrive ALREADY TRANSLATED (ui-kit rule:
 * `ui` never imports the i18n runtime — containers call `t()` and pass
 * strings down).
 */
export interface MenuEntry {
  /** Returned by `ContextMenuService.open()` when the item is picked. */
  readonly id: string;
  /** Pre-translated item text. */
  readonly label: string;
  readonly icon?: IconName;
  /** Destructive action — rendered in the error color. */
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** Draw a divider line above this item. */
  readonly separator?: boolean;
  /** Optional right-aligned hint (e.g. a keyboard shortcut or a value). */
  readonly hint?: string;
  /** Optional native hover tooltip (full value when the label is a short name). */
  readonly title?: string;
}

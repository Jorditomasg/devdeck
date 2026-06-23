/**
 * Atomic UI kit barrel — pure presentational components only.
 *
 * Dependency rule (architecture-v2 §4): `features → ui`; `ui` imports
 * nothing from `core` (no stores, no IPC, no i18n service — all text arrives
 * already translated via inputs/content projection).
 */

// Atoms
export { BUTTON_VARIANTS, ButtonComponent } from './button/button.component';
export type { ButtonSize, ButtonVariant } from './button/button.component';
export { IconButtonComponent } from './icon-button/icon-button.component';
export { IconComponent } from './icon/icon.component';
export type { IconName } from './icon/icon.component';
export { BadgeComponent } from './badge/badge.component';
export type { BadgeTone } from './badge/badge.component';
export { LOG_FLASH_MS, StatusDotComponent } from './status-dot/status-dot.component';
export type { ServiceStatus } from './status-dot/status-dot.component';
export { SpinnerComponent } from './spinner/spinner.component';
export { DividerComponent } from './divider/divider.component';
export { TooltipDirective } from './tooltip/tooltip.directive';
export { TooltipOverlayComponent } from './tooltip/tooltip-overlay.component';

// Molecules
export { SearchableSelectComponent } from './searchable-select/searchable-select.component';
export {
  FILTER_DEBOUNCE_MS,
  MAX_VISIBLE_ROWS,
  PAGE_SIZE,
} from './searchable-select/searchable-select.logic';
export { LogViewerComponent } from './log-viewer/log-viewer.component';
export { DEFAULT_MAX_LINES } from './log-viewer/log-viewer.logic';
export { DialogLogComponent } from './dialog-log/dialog-log.component';
export { DialogShellComponent } from './dialog-shell/dialog-shell.component';
export { DIALOG_WINDOW_MODE, DIALOG_WINDOW_CLOSE } from './dialog-shell/dialog-window-mode';
export type { DialogWindowClose } from './dialog-shell/dialog-window-mode';
export { TabsComponent } from './tabs/tabs.component';
export type { TabDef } from './tabs/tabs.component';
export { PaginationComponent } from './pagination/pagination.component';
export { clampPage, pageCount, pageSlice } from './pagination/pagination.logic';

// Layout helpers
export { FormRowComponent } from './form-row/form-row.component';
export { SectionHeaderComponent } from './section-header/section-header.component';

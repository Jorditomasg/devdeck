# UI Kit — atomic presentational components

Pure presentational layer of DevDeck. Every component is standalone,
`OnPush`, signal-based (`input()` / `model()` / `output()`), and consumes the
design tokens from `src/styles/_tokens.scss` exclusively — **zero hardcoded
colors or sizes**. Shared structural mixins live in `src/styles/_mixins.scss`.

Hard rules (architecture-v2.md §4):

- `ui` imports **nothing** from `core/` — no stores, no IPC, no i18n service.
- All user-visible text arrives **already translated** via inputs or content
  projection; i18n happens in the containers (`features/`).
- Side effects (git, processes, filesystem) never originate here — components
  only emit outputs.

All `§n` references point into `docs/migration/inventory-gui.md`.

## Component → v1 widget map

| Component | Selector | Replaces (v1) | Inventory |
|---|---|---|---|
| `ButtonComponent` | `ui-button` | `ctk.CTkButton` + `theme.btn_style(variant, height)` — all 16 variants, sm/md/lg token heights, optional loading spinner | §29 |
| `IconButtonComponent` | `ui-icon-button` | Narrow square header buttons: ▶/⬛/🔄 (w32), 📁/▼▲ (w28), dialog header controls | §6 |
| `BadgeComponent` | `ui-badge` | Header hint labels: 📥 pull (accent), 📝 changes (warning), ⚠️ conflicts (error), danger-env / deps-missing (warning), muted hint fragments, and the solid repo-type pill (`ui_config.color` bg) | §6, §33 |
| `StatusDotComponent` | `ui-status-dot` | The recolored "🔴" status label — 5 persistent states + transient orange 3s logging flash (`flashTick` counter input; flashes only while running/starting; status changes cancel the revert) | §6, §8, §33 |
| `SpinnerComponent` | `ui-spinner` | Transient busy text ("Scanning…", install/clone progress) | §4, §12, §15 |
| `DividerComponent` | `ui-divider` | `backgrounds.divider` 1px separator frames | §2, §3, §22 |
| `TooltipDirective` (+`TooltipOverlayComponent`) | `[uiTooltip]` | `ToolTip` widget: 500ms delay + 250px wrap from tokens, below-widget +12/+4px placement with viewport flip/clamp, live `update_text`, empty-text cancel, static `hideAll()` for modal-open / hide-to-tray | §31 |
| `SearchableSelectComponent` | `ui-searchable-select` | `SearchableCombo`: 150ms debounced live filter, 30/+30 infinite scroll at ≥98.5%, max 9 visible rows, recents divider (unfiltered only), ellipsized display + full-text title, Escape/outside-click dismissal, live `options` refresh while open. **`[value]` writes never emit** — only user picks fire `selectionChange`/`valueChange` (v1 `set()` contract). v2 adds ↑/↓/Enter keyboard nav (explicitly allowed by the inventory) | §32 |
| `LogViewerComponent` | `ui-log-viewer` | Card / global / detached log textboxes (`theme.log_textbox_style()`): mono sm, app bg, card border, 500-line cap, autoscroll-unless-scrolled-up, selectable text. Perf: line cap + stable absolute-line track keys + `content-visibility: auto` per line (virtual window rejected — see JSDoc) | §5, §8, §29 |
| `DialogShellComponent` | `ui-dialog-shell` | `BaseDialog`: CSS 50% backdrop (replaces the PIL screenshot hack), +20px cascade per `cascadeLevel`, focus trap, configurable ESC/backdrop close, blocked-click **knock** (shake + border flash ≈ v1 `bell()`+lift), header + content + `[uiDialogFooter]` slot, hides all tooltips on open | §13 |
| `FormRowComponent` | `ui-form-row` | Label+control dialog rows (clone, settings, merge, expand panel) | §7, §15, §20, §22 |
| `SectionHeaderComponent` | `ui-section-header` | Section titles with actions (log header + detach/clear, settings sections) | §8, §22 |

## Consumption notes for feature containers

- **Status flash**: increment `[flashTick]` once per received log line for the
  card; the dot owns the 3s timer and the running/starting guard.
- **Searchable select**: pass options pre-ordered (recents first) plus
  `[recentCount]`; profile-apply / merge default-tracking can write `[value]`
  freely — no spurious change events.
- **Log viewer**: the store owns buffers/trimming; pass `[startIndex]` = lines
  already trimmed upstream so track keys stay stable. Batch appends (IPC
  bridge flushes ~50–100ms).
- **Dialogs**: containers own open/close state (`@if` + `(closed)`), stacking
  order and `[cascadeLevel]`; call `knock()` via a component ref for
  programmatic blocked-interaction feedback.
- **Buttons reserve space** (§33): place icon-buttons/actions in
  `flex-shrink: 0` containers so growing labels can't push them off-screen
  (`ui-section-header` already does this for its actions slot).

## Testing

Pure logic is extracted into `*.logic.ts` files with vitest-style specs
(`searchable-select.logic.spec.ts`, `log-viewer.logic.spec.ts`). Test-runner
wiring is a separate task; `tsconfig.app.json` only compiles `src/main.ts`,
so specs never affect the app build.

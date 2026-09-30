/**
 * Pure onboarding-tour rules (kept DOM/driver-free so they stay unit-testable):
 * the step catalog, which steps survive a missing anchor, and when the tour
 * may auto-start.
 */

export interface TourStepDef {
  /** i18n key segment under `onboarding.steps.<id>`. */
  readonly id: string;
  /** `data-tour` anchor; `null` = centered popover with no element. */
  readonly anchor: string | null;
  /** Anchor whose presence decides the step when `anchor` is created on the
   *  fly (the expand panel only exists once its card is expanded). */
  readonly requires?: string;
}

export const TOUR_STEPS: readonly TourStepDef[] = [
  { id: 'repo_card', anchor: 'repo-card' },
  { id: 'card_actions', anchor: 'card-actions' },
  { id: 'git_badges', anchor: 'git-badges' },
  { id: 'card_header', anchor: 'card-header' },
  { id: 'card_expand', anchor: 'card-expand', requires: 'repo-card' },
  { id: 'profile', anchor: 'profile' },
  { id: 'tray', anchor: null },
];

/** Steps whose anchor exists at tour start (anchorless steps always stay). */
export function availableSteps(
  steps: readonly TourStepDef[],
  exists: (anchor: string) => boolean,
): readonly TourStepDef[] {
  return steps.filter((s) => s.anchor === null || exists(s.requires ?? s.anchor));
}

export interface TourTrigger {
  /** Settings mirror loaded (`config() !== null`). */
  readonly configLoaded: boolean;
  readonly seen: boolean;
  /** The startup "What's new" check/dialog is done. */
  readonly startupSettled: boolean;
  readonly scanning: boolean;
  readonly repoCount: number;
  /** Not already started since `seen` last read `true` (once per session). */
  readonly armed: boolean;
}

export function shouldStartTour(t: TourTrigger): boolean {
  return (
    t.configLoaded && !t.seen && t.startupSettled && !t.scanning && t.repoCount > 0 && t.armed
  );
}

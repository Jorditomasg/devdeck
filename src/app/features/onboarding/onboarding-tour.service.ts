/**
 * First-run onboarding tour (driver.js) — main window only.
 *
 * driver.js and its stylesheet stay OUT of the initial bundle: the JS is a
 * dynamic `import('driver.js')`, and the CSS (driver's own + our overrides in
 * `src/styles/onboarding.scss`) is a non-injected global style bundle
 * (`angular.json` → `bundleName: "onboarding"`, `inject: false`) emitted
 * unhashed as `onboarding.css` and linked on first start.
 *
 * Trigger: `onboarding_seen` false + a scanned, non-empty repo list + the
 * startup "What's new" dialog closed ({@link settleStartup}). Finish or skip
 * persists `onboarding_seen = true`. Settings "Replay" (another window) sets
 * it back to `false`; `config://changed` re-syncs the mirror here and the
 * watch effect starts the tour again.
 */
import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import type { Config, Driver } from 'driver.js';

import { TranslationService } from '../../core/i18n/translation.service';
import { ReposStore } from '../../core/state/repos.store';
import { SettingsStore } from '../../core/state/settings.store';
import { WorkspaceStore } from '../workspace/state/workspace.store';
import { EXPAND_ANIM_MS } from '../workspace/workspace.constants';
import { TOUR_STEPS, availableSteps, shouldStartTour } from './onboarding.logic';

const STYLES_HREF = 'onboarding.css';

@Injectable({ providedIn: 'root' })
export class OnboardingTourService {
  private readonly settings = inject(SettingsStore);
  private readonly repos = inject(ReposStore);
  private readonly ws = inject(WorkspaceStore);
  private readonly i18n = inject(TranslationService);

  private readonly startupSettled = signal(false);

  /** Cleared on start, re-armed whenever `onboarding_seen` reads true — so a
   *  replay (true → false) starts again, but a failed persist cannot loop. */
  private armed = true;

  private stylesLoaded: Promise<void> | undefined;

  /** The startup "What's new" check is done (and its dialog, if any, closed). */
  settleStartup(): void {
    this.startupSettled.set(true);
  }

  /** Auto-start watcher; call from the main window's page (injection context). */
  watch(firstRepo: () => string | undefined): void {
    effect(() => {
      const seen = this.settings.onboardingSeen();
      if (seen) {
        this.armed = true;
        return;
      }
      const go = shouldStartTour({
        configLoaded: this.settings.config() !== null,
        seen,
        startupSettled: this.startupSettled(),
        scanning: this.repos.scanning(),
        repoCount: this.repos.repos().length,
        armed: this.armed,
      });
      if (!go) {
        return;
      }
      this.armed = false;
      untracked(() => void this.start(firstRepo()));
    });
  }

  private async start(firstRepo: string | undefined): Promise<void> {
    try {
      const [{ driver }] = await Promise.all([import('driver.js'), this.loadStyles()]);
      // One frame so the freshly scanned card list is in the DOM.
      await new Promise((r) => requestAnimationFrame(r));
      this.run(driver, firstRepo);
    } catch (err: unknown) {
      console.error('onboarding tour failed to start', err);
    }
  }

  private run(driver: (config?: Config) => Driver, firstRepo: string | undefined): void {
    const wasExpanded = firstRepo ? this.ws.card(firstRepo).expanded : true;
    const setExpanded = (expanded: boolean): void => {
      if (firstRepo) {
        this.ws.patchCard(firstRepo, { expanded }, { silent: true });
      }
    };
    const steps = availableSteps(
      TOUR_STEPS,
      (a) => document.querySelector(`[data-tour="${a}"]`) !== null,
    );
    const t = (key: string): string => this.i18n.t(key);
    const skip = t('onboarding.tour.skip');

    const tour = driver({
      steps: steps.map((s) => ({
        element: s.anchor ? `[data-tour="${s.anchor}"]` : undefined,
        data: { id: s.id },
        popover: {
          title: t(`onboarding.steps.${s.id}.title`),
          description: t(`onboarding.steps.${s.id}.text`),
        },
      })),
      popoverClass: 'devdeck-tour',
      showProgress: true,
      progressText: this.i18n.t('onboarding.tour.progress', {
        current: '{{current}}',
        total: '{{total}}',
      }),
      nextBtnText: t('onboarding.tour.next'),
      prevBtnText: t('onboarding.tour.back'),
      doneBtnText: t('onboarding.tour.done'),
      onPopoverRender: (popover) => {
        popover.closeButton.textContent = skip;
        popover.closeButton.setAttribute('aria-label', skip);
      },
      // The expand panel is built lazily on first expand: open the first card
      // and let its expand transition finish before highlighting it.
      onNextClick: (_el, _step, { driver: d }) => {
        const next = d.getNextStep()?.data?.['id'];
        if (next === 'card_expand' && firstRepo && !this.ws.card(firstRepo).expanded) {
          setExpanded(true);
          setTimeout(() => d.moveNext(), EXPAND_ANIM_MS + 100);
          return;
        }
        d.moveNext();
      },
      // Finish, skip, ESC and overlay click all end here.
      onDestroyed: () => {
        if (!wasExpanded) {
          setExpanded(false);
        }
        void this.settings.setOnboardingSeen(true).catch(() => undefined);
      },
    });
    tour.drive();
  }

  /** Link the lazily-emitted `onboarding.css` bundle once. */
  private loadStyles(): Promise<void> {
    this.stylesLoaded ??= new Promise<void>((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = STYLES_HREF;
      // A missing stylesheet must not block the tour (it still works unstyled).
      link.onload = link.onerror = () => resolve();
      document.head.appendChild(link);
    });
    return this.stylesLoaded;
  }
}

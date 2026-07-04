import {
  ChangeDetectionStrategy,
  Component,
  type OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { TranslationService } from '../../../core/i18n/translation.service';
import { IpcCommands } from '../../../core/ipc/commands';
import type { RepoInfo } from '../../../core/ipc/tauri.types';
import { ServicesStore } from '../../../core/state/services.store';
import { ButtonComponent } from '../../../ui/button/button.component';
import { IconButtonComponent } from '../../../ui/icon-button/icon-button.component';
import { IconComponent } from '../../../ui/icon/icon.component';
import { StatusDotComponent } from '../../../ui/status-dot/status-dot.component';
import { TooltipDirective } from '../../../ui/tooltip/tooltip.directive';
import { OpenerService } from '../opener.service';
import { dotStatusFor } from '../repo-card/card-visibility';
import {
  buildPanelServices,
  isRunning,
  runningIds,
  stoppedIds,
  type PanelService,
  type SelectionMap,
} from './tray-panel.logic';

/**
 * Tray quick-control popup (the `?panel=1` window — design doc
 * 2026-06-23-tray-panel-design.md). Custom replacement of the v1 native tray
 * menu (inventory-gui.md §25): a frameless webview shown on a tray right-click.
 *
 * Separate webview ⇒ its own store instances that the main window cannot keep
 * in sync. So instead of trusting the one-shot bootstrap hydration, the panel
 * RE-FETCHES repos + selection (and re-hydrates services) every time it gains
 * focus — i.e. every time the tray shows it. Service status/port stay live
 * through `ServicesStore` (event-fed in this window too).
 */
@Component({
  selector: 'tray-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconButtonComponent, IconComponent, StatusDotComponent, TooltipDirective],
  styleUrl: './tray-panel.component.scss',
  template: `
    <section class="panel">
      <header class="panel__head">
        <span class="panel__summary">{{
          i18n.t('tray.panel.summary', { running: runningCount(), total: total() })
        }}</span>
      </header>

      <div class="panel__bulk">
        <ui-button
          variant="danger"
          size="sm"
          [disabled]="runningCount() === 0"
          (clicked)="stopAll()"
        >
          {{ i18n.t('tray.panel.stop_all') }}
        </ui-button>
        <ui-button
          variant="start"
          size="sm"
          [disabled]="stoppedCount() === 0"
          (clicked)="startAll()"
        >
          {{ i18n.t('tray.panel.start_all') }}
        </ui-button>
      </div>

      <ul class="panel__list">
        @for (svc of rows(); track svc.id) {
          <li class="row">
            <ui-status-dot class="row__dot" [status]="dotStatus(svc.status)" />
            <span class="row__name" [title]="svc.name">{{ svc.name }}</span>
            @if (svc.url) {
              <button
                type="button"
                class="row__port"
                [uiTooltip]="i18n.t('tooltip.open_port')"
                (click)="openUrl(svc.url)"
              >
                :{{ svc.port }}
              </button>
            }
            <span class="row__actions">
              @if (running(svc.status)) {
                <ui-icon-button
                  variant="danger"
                  size="sm"
                  [uiTooltip]="i18n.t('tooltip.stop_btn')"
                  (clicked)="stop(svc.id)"
                  ><ui-icon name="square" [size]="14"
                /></ui-icon-button>
                <ui-icon-button
                  variant="warning"
                  size="sm"
                  [uiTooltip]="i18n.t('tooltip.restart_btn')"
                  (clicked)="restart(svc.id)"
                  ><ui-icon name="refresh" [size]="14"
                /></ui-icon-button>
              } @else {
                <ui-icon-button
                  variant="start"
                  size="sm"
                  [uiTooltip]="i18n.t('tooltip.start_btn')"
                  (clicked)="start(svc.id)"
                  ><ui-icon name="play" [size]="14"
                /></ui-icon-button>
              }
              <ui-icon-button
                variant="neutral"
                size="sm"
                [uiTooltip]="i18n.t('tray.panel.logs_btn')"
                (clicked)="openLogs(svc)"
                ><ui-icon name="file-text" [size]="14"
              /></ui-icon-button>
            </span>
          </li>
        } @empty {
          <li class="panel__empty">{{ i18n.t('tray.panel.empty') }}</li>
        }
      </ul>

      <footer class="panel__foot">
        <ui-button variant="neutral" size="sm" (clicked)="openDevDeck()">
          {{ i18n.t('tray.panel.open_devdeck') }}
        </ui-button>
        <ui-button variant="danger" size="sm" (clicked)="closeDevDeck()">
          {{ i18n.t('tray.panel.close_devdeck') }}
        </ui-button>
      </footer>
    </section>
  `,
})
export class TrayPanelComponent implements OnDestroy {
  protected readonly i18n = inject(TranslationService);
  private readonly commands = inject(IpcCommands);
  private readonly services = inject(ServicesStore);
  private readonly opener = inject(OpenerService);

  /** `isRunning` / `dotStatusFor` exposed for the template. */
  protected readonly running = isRunning;
  protected readonly dotStatus = dotStatusFor;

  private readonly _repos = signal<readonly RepoInfo[]>([]);
  private readonly _selection = signal<SelectionMap>({});
  private focusUnlisten?: UnlistenFn;

  /** Selected services with live status + port. */
  protected readonly rows = computed<readonly PanelService[]>(() =>
    buildPanelServices(
      this._repos(),
      this._selection(),
      (id) => this.services.statusFor(id),
      (id) => this.services.services()[id]?.port,
    ),
  );

  protected readonly total = computed(() => this.rows().length);
  protected readonly runningCount = computed(() => runningIds(this.rows()).length);
  protected readonly stoppedCount = computed(() => stoppedIds(this.rows()).length);

  constructor() {
    void this.refresh();
    // Re-fetch every time the tray shows the panel (it gains focus) — the panel
    // is a separate webview the main window cannot push updates to.
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          void this.refresh();
        }
      })
      .then((unlisten) => {
        this.focusUnlisten = unlisten;
      })
      .catch(() => undefined);
  }

  ngOnDestroy(): void {
    this.focusUnlisten?.();
  }

  /** Re-read repos + selection + the service registry snapshot. */
  private async refresh(): Promise<void> {
    try {
      const [repos, config] = await Promise.all([
        this.commands.detection.listRepos(),
        this.commands.config.getAppConfig(),
        this.services.hydrate(),
      ]);
      this._repos.set(repos);
      this._selection.set(config.repo_state ?? {});
    } catch (err: unknown) {
      console.error('tray panel refresh', err);
    }
  }

  protected start(id: string): void {
    void this.services.start(id).catch((err: unknown) => console.error('tray start', err));
  }

  protected stop(id: string): void {
    void this.services.stop(id).catch((err: unknown) => console.error('tray stop', err));
  }

  protected restart(id: string): void {
    void this.services.restart(id).catch((err: unknown) => console.error('tray restart', err));
  }

  protected startAll(): void {
    for (const id of stoppedIds(this.rows())) {
      this.start(id);
    }
  }

  protected stopAll(): void {
    for (const id of runningIds(this.rows())) {
      this.stop(id);
    }
  }

  protected openLogs(svc: PanelService): void {
    void this.commands
      .openLogWindow(svc.id, `${svc.name} — ${this.i18n.t('label.log_section')}`)
      .catch((err: unknown) => console.error('tray open logs', err));
  }

  protected openUrl(url: string): void {
    void this.opener.openUrl(url);
  }

  protected openDevDeck(): void {
    void this.commands.showMainWindow().catch((err: unknown) => console.error('open devdeck', err));
  }

  protected closeDevDeck(): void {
    void this.commands.requestQuit().catch((err: unknown) => console.error('close devdeck', err));
  }
}

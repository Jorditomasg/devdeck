/**
 * Docker Compose manager — v1 `DockerComposeDialog` (inventory-gui §19).
 *
 * - Service rows parsed from the selected compose file
 *   (`docker_compose_services`), each with live status dot, per-service
 *   Start/Stop (busy states) and a Logs selector.
 * - Header: running counter, auto-refresh switch (5 s forced poll while ON —
 *   v1 §19), Start all (`compose up`) / Stop all (`compose down`).
 * - **Live status via docker events**: Rust polls every 15 s and pushes
 *   `docker://status`; the dialog merges payloads for this repo and forces
 *   one poll after every operation (`docker_refresh_status`) with the v1
 *   +3 s follow-up for slow containers.
 * - Every operation checks the daemon first (`docker_available`); failures
 *   surface the themed `dialog.docker.unavailable_*` messagebox (§12).
 *
 * Deviations from v1 (documented):
 * - v1 opened one dialog PER compose file; the v2 contract opens per REPO —
 *   a compose-file selector appears when the repo declares several files.
 * - The per-service "profile" checkboxes (§19) are NOT here: profile
 *   service selection (`docker_profile_services`) is card/profile state owned
 *   by the workspace feature, which has the card callbacks this dialog no
 *   longer gets.
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import { IpcCommands } from '../../../core/ipc/commands';
import { IpcEvents } from '../../../core/ipc/events';
import type { ComposeService, OpOutput } from '../../../core/ipc/tauri.types';
import { ReposStore } from '../../../core/state/repos.store';
import type { UnlistenFn } from '../../../core/ipc/tauri-bridge';
import {
  ButtonComponent,
  DialogShellComponent,
  SearchableSelectComponent,
  StatusDotComponent,
} from '../../../ui';
import { DialogBase } from '../dialog-base';
import {
  DIALOG_REFRESH_MS,
  LOGS_TAIL,
  composeBasename,
  countRunning,
  mergeStatus,
  serviceState,
  type StatusMap,
} from './docker-compose.logic';

/** v1 post-operation follow-up poll delay (slow containers, §11). */
const FOLLOW_UP_MS = 3000;

@Component({
  selector: 'app-docker-compose-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    DialogShellComponent,
    SearchableSelectComponent,
    StatusDotComponent,
    TPipe,
  ],
  styleUrl: './docker-compose-dialog.component.scss',
  template: `
    <ui-dialog-shell
      [dialogTitle]="title()"
      width="900px"
      [cascadeLevel]="cascadeLevel()"
      (closed)="closeSelf()"
    >
      <div class="docker">
        <!-- Header controls (§19) -->
        <div class="docker__header">
          <h3 class="docker__title">{{ 'docker.title' | t }}</h3>
          <span class="docker__count">{{
            'docker.running_count' | t: { running: running(), total: services().length }
          }}</span>
          <span class="docker__spacer"></span>
          <label class="docker__check">
            <input
              type="checkbox"
              [checked]="autoRefresh()"
              (change)="autoRefresh.set(!autoRefresh())"
            />
            {{ 'docker.auto_refresh' | t }}
          </label>
          <ui-button
            variant="success"
            [loading]="busyAll() === 'up'"
            [disabled]="busyAll() !== null"
            (clicked)="startAll()"
          >
            {{ 'docker.btn_start_all' | t }}
          </ui-button>
          <ui-button
            variant="danger-deep"
            [loading]="busyAll() === 'down'"
            [disabled]="busyAll() !== null"
            (clicked)="stopAll()"
          >
            {{ 'docker.btn_stop_all' | t }}
          </ui-button>
        </div>

        <!-- Compose file selector (v2 — dialog is per repo, see JSDoc) -->
        @if (files().length > 1) {
          <div class="docker__file-row">
            <span class="docker__file-label">{{ 'docker.compose_file_label' | t }}</span>
            <ui-searchable-select
              class="docker__file-combo"
              [options]="files()"
              [value]="file()"
              [searchPlaceholder]="'placeholder.search' | t"
              [noResultsText]="'placeholder.no_results' | t"
              (selectionChange)="onFilePick($event)"
            />
          </div>
        }

        <!-- Service rows (§19) -->
        <div class="docker__list">
          @if (loading()) {
            <p class="docker__hint">{{ 'label.loading' | t }}</p>
          } @else if (services().length === 0) {
            <p class="docker__empty">{{ 'docker.no_services' | t }}</p>
          } @else {
            @for (svc of services(); track svc.name) {
              <div class="docker__row">
                <ui-status-dot
                  [status]="stateOf(svc.name)"
                  [label]="stateLabel(svc.name)"
                />
                <div class="docker__svc">
                  <span class="docker__svc-name">{{ svc.name }}</span>
                  <span class="docker__svc-detail">
                    {{ svc.image }}@if (svc.ports.length > 0) {
                      · {{ svc.ports.join(' · ') }}
                    }
                  </span>
                </div>
                <span
                  class="docker__state docker__state--{{ stateOf(svc.name) }}"
                  >{{ stateLabel(svc.name) }}</span
                >
                <ui-button
                  variant="success"
                  size="sm"
                  [loading]="busy()[svc.name] === 'start'"
                  [disabled]="busy()[svc.name] !== undefined"
                  (clicked)="startService(svc.name)"
                >
                  {{ 'docker.btn_service_start' | t }}
                </ui-button>
                <ui-button
                  variant="danger-deep"
                  size="sm"
                  [loading]="busy()[svc.name] === 'stop'"
                  [disabled]="busy()[svc.name] !== undefined"
                  (clicked)="stopService(svc.name)"
                >
                  {{ 'docker.btn_service_stop' | t }}
                </ui-button>
                <ui-button
                  variant="neutral-alt"
                  size="sm"
                  (clicked)="selectLogs(svc.name)"
                >
                  {{ 'docker.btn_service_logs' | t }}
                </ui-button>
              </div>
            }
          }
        </div>

        <!-- Log panel (§19) -->
        <div class="docker__log-header">
          <span class="docker__log-title">{{ logTitle() }}</span>
          <span class="docker__spacer"></span>
          <ui-button
            variant="neutral"
            size="sm"
            [disabled]="logService() === ''"
            [loading]="logLoading()"
            (clicked)="reloadLogs()"
          >
            {{ 'btn.reload' | t }}
          </ui-button>
          <ui-button variant="log-action" size="sm" (clicked)="logText.set('')">
            {{ 'btn.clear_log' | t }}
          </ui-button>
        </div>
        <pre class="docker__log">{{ logText() }}</pre>
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" (clicked)="closeSelf()">
          {{ 'btn.close' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class DockerComposeDialogComponent extends DialogBase {
  readonly repoName = input.required<string>();

  private readonly commands = inject(IpcCommands);
  private readonly events = inject(IpcEvents);
  private readonly repos = inject(ReposStore);
  private readonly i18n = inject(TranslationService);

  protected readonly file = signal('');
  protected readonly services = signal<readonly ComposeService[]>([]);
  protected readonly loading = signal(false);
  protected readonly status = signal<StatusMap>({});
  /** Per-service in-flight operation (`start` / `stop`). */
  protected readonly busy = signal<Readonly<Record<string, 'start' | 'stop'>>>({});
  protected readonly busyAll = signal<'up' | 'down' | null>(null);
  protected readonly autoRefresh = signal(true); // v1 default ON (§19)
  protected readonly logService = signal('');
  protected readonly logText = signal('');
  protected readonly logLoading = signal(false);

  private unlisten: UnlistenFn | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private followUpTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly files = computed<readonly string[]>(
    () => this.repos.repoByName(this.repoName())?.dockerComposeFiles ?? [],
  );

  protected readonly running = computed(() =>
    countRunning(this.services(), this.status()),
  );

  /** `Docker Compose - {basename}` (v1 window title, §19). */
  protected readonly title = computed(() =>
    this.i18n.t('docker.window_title', {
      name: this.file() !== '' ? composeBasename(this.file()) : this.repoName(),
    }),
  );

  protected readonly logTitle = computed(() =>
    this.logService() === ''
      ? this.i18n.t('docker.logs_title_empty')
      : this.i18n.t('docker.logs_title', { name: this.logService() }),
  );

  constructor() {
    super();
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => {
      this.unlisten?.();
      clearInterval(this.refreshTimer);
      clearTimeout(this.followUpTimer);
    });
    // Inputs are bound after construction (NgComponentOutlet) — init deferred.
    afterNextRender(() => void this.init());
  }

  protected stateOf(name: string): 'running' | 'stopped' {
    return serviceState(this.status(), name);
  }

  protected stateLabel(name: string): string {
    return this.i18n.t(`label.status.${this.stateOf(name)}`);
  }

  protected onFilePick(file: string): void {
    if (file === this.file()) {
      return;
    }
    this.file.set(file);
    this.logService.set('');
    this.logText.set('');
    void this.loadServices();
  }

  // -- operations (§19) -------------------------------------------------------

  protected async startService(name: string): Promise<void> {
    await this.runServiceOp(name, 'start', () =>
      this.commands.docker.composeUp(this.file(), [name]),
    );
  }

  protected async stopService(name: string): Promise<void> {
    await this.runServiceOp(name, 'stop', () =>
      this.commands.docker.composeStop(this.file(), [name]),
    );
  }

  protected async startAll(): Promise<void> {
    await this.runGlobalOp('up', () => this.commands.docker.composeUp(this.file()));
  }

  /** v1 "Stop all" runs `docker compose down` (§19 header). */
  protected async stopAll(): Promise<void> {
    await this.runGlobalOp('down', () =>
      this.commands.docker.composeDown(this.file()),
    );
  }

  protected selectLogs(name: string): void {
    this.logService.set(name);
    void this.reloadLogs();
  }

  protected async reloadLogs(): Promise<void> {
    const service = this.logService();
    if (service === '' || this.logLoading()) {
      return;
    }
    this.logLoading.set(true);
    this.logText.set(this.i18n.t('docker.log_loading', { name: service }));
    try {
      const text = await this.commands.docker.composeLogs(
        this.file(),
        service,
        LOGS_TAIL,
      );
      this.logText.set(text);
    } catch (err: unknown) {
      this.logText.set(describe(err));
    } finally {
      this.logLoading.set(false);
    }
  }

  // -- internals ----------------------------------------------------------------

  private async init(): Promise<void> {
    const first = this.files()[0];
    if (first !== undefined) {
      this.file.set(first);
      await this.loadServices();
    }
    // Live status: fold every docker://status payload for this repo.
    this.unlisten = await this.events.onDockerStatus((e) => {
      if (e.name === this.repoName()) {
        this.status.update((s) => mergeStatus(s, e.services));
      }
    });
    // Dialog auto-refresh: force a poll every 5 s while the switch is ON.
    this.refreshTimer = setInterval(() => {
      if (this.autoRefresh()) {
        void this.forceRefresh();
      }
    }, DIALOG_REFRESH_MS);
  }

  private async loadServices(): Promise<void> {
    this.loading.set(true);
    try {
      const services = await this.commands.docker.composeServices(this.file());
      this.services.set(services);
      await this.forceRefresh();
    } catch (err: unknown) {
      this.services.set([]);
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    } finally {
      this.loading.set(false);
    }
  }

  /** Force one Rust-side poll; the result arrives as `docker://status`. */
  private async forceRefresh(): Promise<void> {
    const names = this.services().map((s) => s.name);
    if (this.file() === '' || names.length === 0) {
      return;
    }
    try {
      await this.commands.docker.refreshStatus(this.repoName(), this.file(), names);
    } catch {
      // Poll failures are transient; the 5 s loop retries.
    }
  }

  /** Daemon gate shared by every operation (§12 docker check). */
  private async ensureDaemon(): Promise<boolean> {
    const available = await this.commands.docker.available().catch(() => false);
    if (!available) {
      await this.dialogs.error(
        this.i18n.t('dialog.docker.unavailable_title'),
        this.i18n.t('dialog.docker.unavailable_msg'),
      );
    }
    return available;
  }

  private async runServiceOp(
    name: string,
    kind: 'start' | 'stop',
    op: () => Promise<OpOutput>,
  ): Promise<void> {
    if (this.busy()[name] !== undefined || !(await this.ensureDaemon())) {
      return;
    }
    this.busy.update((b) => ({ ...b, [name]: kind }));
    try {
      const result = await op();
      if (!result.ok) {
        await this.dialogs.error(this.i18n.t('misc.error_title'), result.message);
      }
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    } finally {
      this.busy.update((b) => {
        const next = { ...b };
        delete next[name];
        return next;
      });
      this.refreshSoon();
    }
  }

  private async runGlobalOp(
    kind: 'up' | 'down',
    op: () => Promise<OpOutput>,
  ): Promise<void> {
    if (this.busyAll() !== null || !(await this.ensureDaemon())) {
      return;
    }
    this.busyAll.set(kind);
    try {
      const result = await op();
      if (!result.ok) {
        await this.dialogs.error(this.i18n.t('misc.error_title'), result.message);
      }
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    } finally {
      this.busyAll.set(null);
      this.refreshSoon();
    }
  }

  /** Immediate poll + one +3 s follow-up for slow containers (v1 §11). */
  private refreshSoon(): void {
    void this.forceRefresh();
    clearTimeout(this.followUpTimer);
    this.followUpTimer = setTimeout(() => void this.forceRefresh(), FOLLOW_UP_MS);
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

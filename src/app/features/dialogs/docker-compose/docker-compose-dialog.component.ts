/**
 * Docker Compose manager — v1 `DockerComposeDialog` (inventory-gui §19).
 *
 * - Service rows parsed from the selected compose file
 *   (`docker_compose_services`), each with live status dot, per-service
 *   Start/Stop (busy states), a profile-selection checkbox and a Logs selector.
 * - Header: running counter, auto-refresh switch (5 s forced poll while ON —
 *   v1 §19), Start all (`compose up`) / Stop all (`compose down`).
 * - **Live status via docker events**: Rust polls every 15 s and pushes
 *   `docker://status`; the dialog merges payloads for this repo and forces
 *   one poll after every operation (`docker_refresh_status`) with the v1
 *   +3 s follow-up for slow containers.
 * - **Live logs** (design doc 2026-07-05): the Logs selector attaches to a
 *   `docker compose logs -f` follower (`docker_log_start`) whose lines flow
 *   through the shared `service://log-line` pipeline under the synthetic id
 *   `docker::<file>::<service>` — so the panel reuses `ServicesStore.logsFor`
 *   like every other log, is detachable via `open_log_window`, and the stream
 *   only runs while attached. "Load full history" fetches the `--tail=all`
 *   snapshot on demand.
 * - **Profile selection** (design doc 2026-07-05): the per-service checkboxes
 *   relay through `set_docker_selection` (this dialog runs in an isolated
 *   webview and cannot touch the main window's store directly); the main
 *   window folds `docker://selection` into card state and marks the profile
 *   dirty. Selecting services makes the file "active" for the profile start.
 * - Every operation checks the daemon first (`docker_available`); failures
 *   surface the themed `dialog.docker.unavailable_*` messagebox (§12).
 *
 * Deviations from v1 (documented):
 * - The dialog is opened per REPO but LOCKED to the compose file the user
 *   picked on the card (`composeFile` input). Like v1, one window = one compose
 *   file; the in-dialog selector only appears as a fallback when no file was
 *   passed AND the repo declares several files.
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
import { ServicesStore } from '../../../core/state/services.store';
import type { UnlistenFn } from '../../../core/ipc/tauri-bridge';
import {
  ButtonComponent,
  DialogLogComponent,
  DialogShellComponent,
  SearchableSelectComponent,
  StatusDotComponent,
} from '../../../ui';
import { DialogBase } from '../dialog-base';
import {
  DIALOG_REFRESH_MS,
  composeBasename,
  countRunning,
  dockerLogId,
  mergeStatus,
  serviceState,
  type StatusMap,
} from './docker-compose.logic';

/** v1 post-operation follow-up poll delay (slow containers, §11). */
const FOLLOW_UP_MS = 3000;

/** Tail requested by "Load full history" — effectively `--tail all`. */
const FULL_TAIL = 100_000;

@Component({
  selector: 'app-docker-compose-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    DialogLogComponent,
    DialogShellComponent,
    SearchableSelectComponent,
    StatusDotComponent,
    TPipe,
  ],
  styleUrl: './docker-compose-dialog.component.scss',
  template: `
    <ui-dialog-shell
      [dialogTitle]="title()"
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
            [disabled]="busyAll() !== null || running() === services().length"
            (clicked)="startAll()"
          >
            {{ 'docker.btn_start_all' | t }}
          </ui-button>
          <ui-button
            variant="danger-deep"
            [loading]="busyAll() === 'down'"
            [disabled]="busyAll() !== null || running() === 0"
            (clicked)="stopAll()"
          >
            {{ 'docker.btn_stop_all' | t }}
          </ui-button>
        </div>

        <!-- Compose file selector — fallback only when no file was locked in. -->
        @if (composeFile() === '' && files().length > 1) {
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
                <label class="docker__pick" [title]="'docker.select_service' | t">
                  <input
                    type="checkbox"
                    [checked]="isSelected(svc.name)"
                    (change)="toggleService(svc.name)"
                  />
                </label>
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
                @if (stateOf(svc.name) === 'running') {
                  <ui-button
                    variant="danger-deep"
                    size="sm"
                    [loading]="busy()[svc.name] === 'stop'"
                    [disabled]="busy()[svc.name] !== undefined"
                    (clicked)="stopService(svc.name)"
                  >
                    {{ 'docker.btn_service_stop' | t }}
                  </ui-button>
                } @else {
                  <ui-button
                    variant="success"
                    size="sm"
                    [loading]="busy()[svc.name] === 'start'"
                    [disabled]="busy()[svc.name] !== undefined"
                    (clicked)="startService(svc.name)"
                  >
                    {{ 'docker.btn_service_start' | t }}
                  </ui-button>
                }
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

        <!-- Log panel — live "logs -f" stream (§19 + design doc 2026-07-05) -->
        @if (logService() !== '') {
          <div class="docker__log-actions">
            <ui-button
              variant="neutral"
              size="sm"
              [loading]="logLoading()"
              (clicked)="toggleFull()"
            >
              {{ (showingFull() ? 'docker.btn_live_logs' : 'docker.btn_full_logs') | t }}
            </ui-button>
          </div>
        }
        <ui-dialog-log
          [label]="logLabel()"
          [lines]="displayLines()"
          [emptyText]="'label.log_empty' | t"
          [detachText]="'btn.detach_log' | t"
          [clearText]="'btn.clear_log' | t"
          [canDetach]="logService() !== '' && !showingFull()"
          (detach)="detachLog()"
          (clear)="clearLog()"
        />
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
  /** Compose file to lock onto (picked on the card). Empty = selector fallback. */
  readonly composeFile = input<string>('');
  /** Card's currently-selected services for the locked file (checkbox seed). */
  readonly selectedServices = input<readonly string[]>([]);
  /** Whether the locked file is currently active in the profile (seed). */
  readonly active = input<boolean>(false);

  private readonly commands = inject(IpcCommands);
  private readonly events = inject(IpcEvents);
  private readonly repos = inject(ReposStore);
  private readonly servicesStore = inject(ServicesStore);
  private readonly i18n = inject(TranslationService);

  protected readonly file = signal('');
  protected readonly services = signal<readonly ComposeService[]>([]);
  protected readonly loading = signal(false);
  protected readonly status = signal<StatusMap>({});
  /** Per-service in-flight operation (`start` / `stop`). */
  protected readonly busy = signal<Readonly<Record<string, 'start' | 'stop'>>>({});
  protected readonly busyAll = signal<'up' | 'down' | null>(null);
  protected readonly autoRefresh = signal(true); // v1 default ON (§19)

  /** Profile-selected service names for the current file (checkbox state). */
  private readonly selected = signal<ReadonlySet<string>>(new Set());

  // -- live log state --
  /** Service whose log is shown (`''` = none). */
  protected readonly logService = signal('');
  /** Absolute line number of the first shown live line (clear / trim baseline). */
  protected readonly logBaseline = signal(0);
  /** Full-history snapshot lines when "Load full history" is active, else null. */
  private readonly fullHistory = signal<readonly string[] | null>(null);
  protected readonly logLoading = signal(false);

  private unlisten: UnlistenFn | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private followUpTimer: ReturnType<typeof setTimeout> | undefined;
  /** Currently-attached `docker::…` id (so we can detach on switch/close). */
  private attachedId = '';

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

  protected readonly showingFull = computed(() => this.fullHistory() !== null);

  protected readonly logLabel = computed(() =>
    this.logService() === ''
      ? this.i18n.t('docker.logs_title_empty')
      : this.i18n.t('docker.logs_title', { name: this.logService() }),
  );

  /** Synthetic log id of the shown service (`''` when none). */
  private readonly logId = computed(() => {
    const service = this.logService();
    return service === '' ? '' : dockerLogId(this.file(), service);
  });

  /** Lines shown in the panel: full-history snapshot, else the live stream. */
  protected readonly displayLines = computed<readonly string[]>(() => {
    const full = this.fullHistory();
    if (full !== null) {
      return full;
    }
    const id = this.logId();
    if (id === '') {
      return [];
    }
    // `logBaseline` is an ABSOLUTE line number (Clear bumps it to the current
    // end); convert to a buffer index with the ring-buffer's head-trim count so
    // Clear stays correct even after the 500-line cap starts dropping lines.
    const dropped = this.servicesStore.droppedFor(id)();
    const from = Math.max(0, this.logBaseline() - dropped);
    return this.servicesStore
      .logsFor(id)()
      .slice(from)
      .filter((l) => l.stream === 'docker')
      .map((l) => l.line);
  });

  constructor() {
    super();
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => {
      this.unlisten?.();
      clearInterval(this.refreshTimer);
      clearTimeout(this.followUpTimer);
      this.detachLogStream();
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

  protected isSelected(name: string): boolean {
    return this.selected().has(name);
  }

  protected onFilePick(file: string): void {
    if (file === this.file()) {
      return;
    }
    this.detachLogStream();
    this.file.set(file);
    this.logService.set('');
    // Seed only applies to the initially-locked file; other files start clean.
    this.selected.set(new Set());
    void this.loadServices();
  }

  // -- profile selection (design doc 2026-07-05) ------------------------------

  /**
   * Toggle a service's profile selection and relay it to the main window
   * (`set_docker_selection` → `docker://selection`). The file is "active" for
   * the profile start whenever at least one service is selected.
   */
  protected toggleService(name: string): void {
    const next = new Set(this.selected());
    if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }
    this.selected.set(next);
    const list = [...next];
    void this.commands.docker
      .setSelection(this.repoName(), composeBasename(this.file()), list, list.length > 0)
      .catch((err: unknown) => console.error('docker selection relay failed', err));
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

  // -- live logs (design doc 2026-07-05) --------------------------------------

  /** Show one service's LIVE log: detach the previous stream, attach the new. */
  protected selectLogs(name: string): void {
    if (name === this.logService()) {
      return;
    }
    this.detachLogStream();
    this.fullHistory.set(null);
    this.logService.set(name);
    const id = this.logId();
    // Live buffer for a fresh id starts empty; baseline 0 shows all from now.
    this.logBaseline.set(0);
    this.attachedId = id;
    void this.commands.docker
      .logStart(id)
      .catch((err: unknown) => console.error('docker log start failed', err));
  }

  /** Detach the live log into its own OS window (reuses `open_log_window`). */
  protected detachLog(): void {
    const id = this.logId();
    if (id === '') {
      return;
    }
    void this.commands
      .openLogWindow(id, this.i18n.t('docker.logs_title', { name: this.logService() }))
      .catch((err: unknown) => console.error('open log window failed', err));
  }

  /** Clear the in-dialog view (baseline bump — the live buffer keeps filling). */
  protected clearLog(): void {
    if (this.fullHistory() !== null) {
      this.fullHistory.set([]);
      return;
    }
    const id = this.logId();
    if (id !== '') {
      // Absolute end = first buffered line's number + current length; slicing
      // from here hides everything up to now while live lines keep arriving.
      this.logBaseline.set(
        this.servicesStore.droppedFor(id)() + this.servicesStore.logsFor(id)().length,
      );
    }
  }

  /** Toggle between the live tail and the full `--tail all` history snapshot. */
  protected async toggleFull(): Promise<void> {
    if (this.fullHistory() !== null) {
      this.fullHistory.set(null);
      return;
    }
    const service = this.logService();
    if (service === '' || this.logLoading()) {
      return;
    }
    this.logLoading.set(true);
    try {
      const text = await this.commands.docker.composeLogs(this.file(), service, FULL_TAIL);
      this.fullHistory.set(text.split('\n'));
    } catch (err: unknown) {
      this.fullHistory.set([describe(err)]);
    } finally {
      this.logLoading.set(false);
    }
  }

  private detachLogStream(): void {
    if (this.attachedId !== '') {
      void this.commands.docker
        .logStop(this.attachedId)
        .catch((err: unknown) => console.error('docker log stop failed', err));
      this.attachedId = '';
    }
  }

  // -- internals ----------------------------------------------------------------

  private async init(): Promise<void> {
    const locked = this.composeFile();
    const initial = locked !== '' ? locked : this.files()[0];
    if (initial !== undefined) {
      this.file.set(initial);
      // Seed the checkboxes with the card's current selection for this file.
      this.selected.set(new Set(this.selectedServices()));
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

/**
 * Detached log window content — the v1 detached log CTkToplevel
 * (inventory-gui.md §5/§8) as a real OS window.
 *
 * Rendered INSTEAD of the workspace page when the SPA is loaded with
 * `?log=<serviceId>` (see `app.component.ts`); the window itself is created
 * Rust-side by the `open_log_window` command. The buffer is local to this
 * window: seeded once from the Rust `LogCache` backlog (`get_log_backlog`),
 * then appended from live `service://log-line` events — for the
 * `GLOBAL_LOG_ID` aggregate every service's lines are shown with the same
 * `[name] ` prefix the cache uses.
 */
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';

import { TranslationService } from '../../../core/i18n/translation.service';
import { GLOBAL_LOG_ID, IpcCommands } from '../../../core/ipc/commands';
import { IpcEvents } from '../../../core/ipc/events';
import { ButtonComponent, IconComponent, LogViewerComponent } from '../../../ui';

/** Detached windows can afford a deeper buffer than the in-card viewer. */
const DETACHED_LINE_CAP = 5000;

@Component({
  selector: 'log-window',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, LogViewerComponent],
  styleUrl: './log-window.component.scss',
  template: `
    <header class="logwin__header">
      <span class="logwin__title">{{ title() }}</span>
      <span class="logwin__spacer"></span>
      <ui-button variant="log-action" size="sm" (clicked)="onCopy()">
        <ui-icon name="copy" [size]="13" /> {{ i18n.t('btn.copy_log') }}
      </ui-button>
      <ui-button variant="log-action" size="sm" (clicked)="onClear()">
        <ui-icon name="trash" [size]="13" /> {{ i18n.t('btn.clear_log') }}
      </ui-button>
    </header>
    <ui-log-viewer
      class="logwin__view"
      [lines]="lines()"
      [startIndex]="dropped()"
      [maxLines]="cap"
      [emptyText]="i18n.t('label.log_empty')"
    />
  `,
})
export class LogWindowComponent implements OnInit, OnDestroy {
  protected readonly i18n = inject(TranslationService);
  private readonly commands = inject(IpcCommands);
  private readonly events = inject(IpcEvents);

  /** Service id from the `?log=` query param (set by app.component). */
  readonly serviceId = signal('');

  protected readonly cap = DETACHED_LINE_CAP;
  protected readonly lines = signal<readonly string[]>([]);
  /** Lines trimmed from the head — keeps log-viewer track keys stable. */
  protected readonly dropped = signal(0);

  protected readonly title = computed(() =>
    this.serviceId() === GLOBAL_LOG_ID
      ? this.i18n.t('label.global_log_section')
      : this.serviceId(),
  );

  private unlisten: (() => void) | null = null;

  async ngOnInit(): Promise<void> {
    const id = new URLSearchParams(window.location.search).get('log') ?? '';
    this.serviceId.set(id);
    document.title = `${this.title()} — DevDeck`;

    // Subscribe BEFORE seeding so no line can fall between backlog and live.
    // (A line in both would be a rare dup — v1 accepted the same.)
    this.unlisten = await this.events.onServiceLogLine((e) => {
      const isGlobal = id === GLOBAL_LOG_ID;
      if (!isGlobal && e.name !== id) {
        return;
      }
      const incoming = isGlobal ? e.lines.map((l) => `[${e.name}] ${l}`) : e.lines;
      this.append(incoming);
    });
    try {
      const backlog = await this.commands.getLogBacklog(id);
      this.lines.update((live) => [...backlog, ...live]);
    } catch (err: unknown) {
      console.error('log backlog unavailable', err);
    }
  }

  ngOnDestroy(): void {
    this.unlisten?.();
  }

  protected onCopy(): void {
    void navigator.clipboard.writeText(this.lines().join('\n'));
  }

  protected onClear(): void {
    this.lines.set([]);
    this.dropped.set(0);
  }

  private append(incoming: readonly string[]): void {
    this.lines.update((current) => {
      const merged = [...current, ...incoming];
      const overflow = merged.length - DETACHED_LINE_CAP;
      if (overflow > 0) {
        this.dropped.update((d) => d + overflow);
        return merged.slice(overflow);
      }
      return merged;
    });
  }
}

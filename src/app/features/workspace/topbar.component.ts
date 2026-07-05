/**
 * Topbar container (inventory-gui.md §2): logo, workspace path ↔ group
 * selector swap (`showGroupSelector`, §2/§27), the profile dropdown with the
 * §26 dirty `name *` styling, and the right action buttons (quick-save,
 * manage profiles, clone, rescan, settings, groups).
 *
 * Scan orchestration stays in `workspace-page` — this container emits
 * `groupChanged` / `rescanRequested` instead of scanning itself, so the
 * rescan flow (scan → prune → repo-state restore → profile reload) has a
 * single owner.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  output,
} from '@angular/core';

import { TranslationService } from '../../core/i18n/translation.service';
import { IpcCommands } from '../../core/ipc/commands';
import { ProfilesStore, profileOverwriteDiff } from '../../core/state/profiles.store';
import { SettingsStore } from '../../core/state/settings.store';
import { UpdatesStore } from '../../core/state/updates.store';
import {
  ButtonComponent,
  IconButtonComponent,
  IconComponent,
  SearchableSelectComponent,
  TooltipDirective,
} from '../../ui';
import { DialogService } from '../dialogs/dialog.service';
import { OpenerService } from './opener.service';
import { RepoActionsService } from './state/repo-actions.service';
import { WorkspaceStore } from './state/workspace.store';
import {
  profileDisplayName,
  profileDropdownOptions,
  showGroupSelector,
} from './workspace-logic';

/** The v1 Default group maps to the profiles-store root (backend §15.1). */
export function profileGroupArg(groupName: string | undefined): string | undefined {
  return groupName === undefined || groupName === 'Default' ? undefined : groupName;
}

@Component({
  selector: 'app-topbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    IconButtonComponent,
    IconComponent,
    SearchableSelectComponent,
    TooltipDirective,
  ],
  styleUrl: './topbar.component.scss',
  template: `
    <span class="topbar__logo">{{ i18n.t('label.app_title') }}</span>

    <!-- §2 swap rule: group selector replaces the path label -->
    @if (showGroups()) {
      <div class="topbar__group">
        <span class="topbar__group-label">{{ i18n.t('label.group') }}</span>
        <ui-searchable-select
          class="topbar__group-select"
          [options]="groupNames()"
          [value]="activeGroupName()"
          [searchPlaceholder]="i18n.t('placeholder.search')"
          [noResultsText]="i18n.t('placeholder.no_results')"
          (selectionChange)="onGroupSelected($event)"
        />
        <ui-icon-button
          variant="neutral"
          [uiTooltip]="i18n.t('tooltip.manage_groups')"
          (clicked)="dialogs.openWorkspaceGroups()"
        ><ui-icon name="settings" /></ui-icon-button>
      </div>
    } @else {
      <button
        type="button"
        class="topbar__path"
        [uiTooltip]="i18n.t('tooltip.workspace_dir', { path: workspacePath() })"
        (click)="onPathClick()"
      >{{ workspacePath() }}</button>
    }

    <!-- right group reserves space (§33) -->
    <div class="topbar__actions">
      <span class="topbar__profile-label">{{ i18n.t('label.profile') }}</span>
      <ui-searchable-select
        class="topbar__profile"
        [class.topbar__profile--dirty]="dirty()"
        [options]="profileOptions()"
        [value]="profileDisplay()"
        [searchPlaceholder]="i18n.t('placeholder.search')"
        [noResultsText]="i18n.t('placeholder.no_results')"
        [uiTooltip]="i18n.t('tooltip.profile_selector')"
        (selectionChange)="onProfileSelected($event)"
      />
      @if (dirty()) {
        <ui-icon-button
          variant="neutral"
          size="lg"
          [uiTooltip]="i18n.t('tooltip.save_profile')"
          (clicked)="onQuickSave()"
        ><ui-icon name="save" /></ui-icon-button>
      }
      <ui-icon-button
        variant="neutral"
        size="lg"
        [uiTooltip]="i18n.t('tooltip.manage_profiles')"
        (clicked)="dialogs.openProfileManager()"
      ><ui-icon name="user" /></ui-icon-button>
      <ui-button
        variant="blue"
        size="lg"
        [uiTooltip]="i18n.t('tooltip.clone_btn')"
        (clicked)="dialogs.openClone()"
      ><ui-icon name="plus" [size]="15" /> {{ i18n.t('btn.clone') }}</ui-button>
      <ui-button
        variant="warning"
        size="lg"
        [uiTooltip]="i18n.t('tooltip.rescan_btn')"
        (clicked)="rescanRequested.emit()"
      ><ui-icon name="refresh" [size]="15" /> {{ i18n.t('btn.rescan') }}</ui-button>
      <span class="topbar__settings">
        <ui-icon-button
          variant="neutral"
          size="lg"
          [uiTooltip]="updateAvailable() ? i18n.t('tooltip.settings_btn_update') : i18n.t('tooltip.settings_btn')"
          (clicked)="dialogs.openSettings()"
        ><ui-icon name="settings" /></ui-icon-button>
        @if (updateAvailable()) {
          <span class="topbar__update-dot" aria-hidden="true"></span>
        }
      </span>
    </div>
  `,
})
export class TopbarComponent {
  /** Active group changed via the selector — the page rescans + reloads. */
  readonly groupChanged = output<string>();
  /** Rescan button — the page owns the scan flow (§4). */
  readonly rescanRequested = output<void>();

  protected readonly groupNames = computed(() =>
    this.settings.workspaceGroups().map((g) => g.name),
  );

  protected readonly activeGroupName = computed(
    () => this.settings.activeGroup()?.name ?? '',
  );

  /** §2 swap rule (`showGroupSelector`). */
  protected readonly showGroups = computed(() =>
    showGroupSelector(
      this.settings.workspaceGroups().length,
      this.settings.activeGroup()?.paths.length ?? 0,
    ),
  );

  protected readonly workspacePath = computed(
    () => this.settings.activeGroup()?.paths[0] ?? '',
  );

  /** Active name with the no-profile sentinel folded in (§26). */
  private readonly activeName = computed(() =>
    this.ws.noProfileSelected() ? null : this.profiles.activeProfileName(),
  );

  protected readonly dirty = computed(() => this.ws.profileDirty());

  /** Startup `checkSilently()` populates this — drives the gear badge. */
  protected readonly updateAvailable = computed(
    () => this.updates.info()?.available ?? false,
  );

  protected readonly profileDisplay = computed(() =>
    profileDisplayName(
      this.activeName(),
      this.dirty(),
      this.i18n.t('label.no_profile'),
    ),
  );

  protected readonly profileOptions = computed(() =>
    profileDropdownOptions(
      this.profiles.profiles(),
      this.activeName(),
      this.i18n.t('label.no_profile'),
    ),
  );

  constructor(
    protected readonly i18n: TranslationService,
    protected readonly dialogs: DialogService,
    private readonly settings: SettingsStore,
    private readonly updates: UpdatesStore,
    private readonly commands: IpcCommands,
    private readonly profiles: ProfilesStore,
    private readonly ws: WorkspaceStore,
    private readonly actions: RepoActionsService,
    private readonly opener: OpenerService,
  ) {}

  /** Path label click → OS file explorer (§2). */
  protected onPathClick(): void {
    const path = this.workspacePath();
    if (path) {
      void this.opener.openPath(path);
    }
  }

  protected onGroupSelected(name: string): void {
    if (name && name !== this.activeGroupName()) {
      this.groupChanged.emit(name);
    }
  }

  /** §26 dropdown: sentinel clears the active profile; a name loads+applies. */
  protected async onProfileSelected(value: string): Promise<void> {
    const group = profileGroupArg(this.settings.activeGroup()?.name);
    if (value === this.i18n.t('label.no_profile')) {
      this.ws.clearActiveProfile();
      // Persist the sentinel so the next start does NOT re-apply a profile.
      void this.settings.setLastProfile(group ?? null, null).catch(() => undefined);
      return;
    }
    const doc = await this.profiles.load(value, group).catch(() => null);
    if (!doc) {
      await this.dialogs.error(
        this.i18n.t('misc.error_title'),
        this.i18n.t('log.profile_load_error', { name: value }),
      );
      return;
    }
    await this.actions.applyProfile(doc, { sideEffects: true });
    // Persist as the group's last profile (§26 startup re-apply source).
    void this.settings.setLastProfile(group ?? null, value).catch(() => undefined);
  }

  /**
   * §26 quick save: overwrite the active profile, or open the manager. Before
   * overwriting, show the per-repo diff (branch/profile/java/docker/…) in a
   * confirm so the save is never silent — same preview the manager uses.
   */
  protected async onQuickSave(): Promise<void> {
    const active = this.activeName();
    if (!active) {
      this.dialogs.openProfileManager();
      return;
    }
    const group = profileGroupArg(this.settings.activeGroup()?.name);
    const doc = this.ws.buildProfileDocument();
    const stored = await this.commands.profiles.loadProfile(active, group).catch(() => null);
    const diff = stored ? profileOverwriteDiff(stored, doc) : [];
    const confirmed = await this.dialogs.confirmOverwrite(active, diff);
    if (!confirmed) {
      return;
    }
    await this.profiles.save({ name: active, group, doc, includeConfigFiles: true });
    this.ws.scheduleDirtyCheck();
  }
}

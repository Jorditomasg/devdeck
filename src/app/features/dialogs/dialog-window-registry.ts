/**
 * Maps a dialog `kind` (the `?dialog=` query value passed to a `dlg-*` window)
 * to a LAZY loader for the component `dialog-window-host` instantiates.
 *
 * Loaders are dynamic imports on purpose: nothing here is statically imported,
 * so this file (eagerly loaded by `dialog-window-host` in every window) adds no
 * module-eval edges — critical for `profile-manager`, whose static import would
 * reintroduce the `dialog.service → profile-manager → repo-actions` cycle the
 * lazy import was created to break (see `DialogService.openProfileManager`).
 *
 * Every modal is a native window (docs/migration/dialogs-as-windows.md): one
 * entry per dialog kind. The `openKind`/`openKindForResult` API on `DialogsApi`
 * resolves a kind to a window; the host resolves the same kind to a component.
 */
import type { Type } from '@angular/core';

export type DialogComponentLoader = () => Promise<Type<unknown>>;

export const DIALOG_WINDOW_COMPONENTS: Readonly<Record<string, DialogComponentLoader>> = {
  messagebox: () =>
    import('./messagebox/messagebox.component').then((m) => m.MessageboxComponent),
  prompt: () => import('./prompt/prompt-dialog.component').then((m) => m.PromptDialogComponent),
  settings: () =>
    import('./settings/settings-dialog.component').then((m) => m.SettingsDialogComponent),
  'java-manager': () =>
    import('./settings/java-manager-dialog.component').then((m) => m.JavaManagerDialogComponent),
  'java-editor': () =>
    import('./settings/java-editor-dialog.component').then((m) => m.JavaEditorDialogComponent),
  changelog: () =>
    import('./changelog/changelog-dialog.component').then((m) => m.ChangelogDialogComponent),
  clone: () => import('./clone/clone-dialog.component').then((m) => m.CloneDialogComponent),
  'workspace-groups': () =>
    import('./workspace-groups/workspace-groups-dialog.component').then(
      (m) => m.WorkspaceGroupsDialogComponent,
    ),
  'config-editor': () =>
    import('./config-editor/config-editor-dialog.component').then(
      (m) => m.ConfigEditorDialogComponent,
    ),
  'docker-compose': () =>
    import('./docker-compose/docker-compose-dialog.component').then(
      (m) => m.DockerComposeDialogComponent,
    ),
  'repo-config-manager': () =>
    import('./repo-config-manager/repo-config-manager-dialog.component').then(
      (m) => m.RepoConfigManagerDialogComponent,
    ),
  'command-profile-manager': () =>
    import('./command-profile-manager/command-profile-manager-dialog.component').then(
      (m) => m.CommandProfileManagerDialogComponent,
    ),
  'merge-branch': () =>
    import('./merge-branch/merge-branch-dialog.component').then(
      (m) => m.MergeBranchDialogComponent,
    ),
  branch: () => import('./branch/branch-dialog.component').then((m) => m.BranchDialogComponent),
  stash: () => import('./stash/stash-dialog.component').then((m) => m.StashDialogComponent),
  'confirm-close': () =>
    import('./confirm-close/confirm-close-dialog.component').then(
      (m) => m.ConfirmCloseDialogComponent,
    ),
  'profile-manager': () =>
    import('./profile-manager/profile-manager-dialog.component').then(
      (m) => m.ProfileManagerDialogComponent,
    ),
  'import-options': () =>
    import('./profile-manager/import-options-dialog.component').then(
      (m) => m.ImportOptionsDialogComponent,
    ),
};

/**
 * Maps a dialog `kind` (the `?dialog=` query value passed to a `dlg-*` window)
 * to the component `dialog-window-host` instantiates for it.
 *
 * Grows one entry per migration phase (docs/migration/dialogs-as-windows.md).
 * Phase 1: `messagebox` only.
 */
import type { Type } from '@angular/core';

import { MessageboxComponent } from './messagebox/messagebox.component';
import { PromptDialogComponent } from './prompt/prompt-dialog.component';
import { WorkspaceGroupsDialogComponent } from './workspace-groups/workspace-groups-dialog.component';

export const DIALOG_WINDOW_COMPONENTS: Readonly<Record<string, Type<unknown>>> = {
  messagebox: MessageboxComponent,
  prompt: PromptDialogComponent,
  'workspace-groups': WorkspaceGroupsDialogComponent,
};

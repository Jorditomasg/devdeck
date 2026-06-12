/**
 * Native file/directory pickers — typed wrappers over the Tauri 2 dialog
 * plugin (`tauri-plugin-dialog`, registered Rust-side with the
 * `dialog:default` capability).
 *
 * DOCUMENTED DEVIATION from the "no stringly-typed invoke outside core/ipc"
 * rule (architecture-v2.md §3.1): the picker commands belong to the dialog
 * PLUGIN, not to the app's command contract (ipc-contract.md lists app
 * commands only), and the `@tauri-apps/plugin-dialog` JS guest package is
 * not a dependency — so the plugin's wire commands (`plugin:dialog|open` /
 * `plugin:dialog|save`, the exact strings the guest package itself invokes)
 * are wrapped HERE, once, behind a typed injectable. No other dialog file
 * may invoke them directly.
 */
import { Injectable } from '@angular/core';

import { TauriBridge } from '../../../core/ipc/tauri-bridge';

/** One extension filter group of a file picker. */
export interface FileFilter {
  readonly name: string;
  readonly extensions: readonly string[];
}

@Injectable({ providedIn: 'root' })
export class NativePickers {
  constructor(private readonly bridge: TauriBridge) {}

  /** Native directory chooser. Resolves the absolute path, or `null` on cancel. */
  async pickDirectory(title: string): Promise<string | null> {
    const result = await this.bridge.invoke<string | string[] | null>(
      'plugin:dialog|open',
      { options: { title, directory: true, multiple: false } },
    );
    return typeof result === 'string' ? result : null;
  }

  /** Native open-file chooser. Resolves the absolute path, or `null` on cancel. */
  async pickOpenFile(
    title: string,
    filters?: readonly FileFilter[],
  ): Promise<string | null> {
    const result = await this.bridge.invoke<string | string[] | null>(
      'plugin:dialog|open',
      { options: { title, directory: false, multiple: false, filters } },
    );
    return typeof result === 'string' ? result : null;
  }

  /** Native save-file chooser. Resolves the chosen path, or `null` on cancel. */
  pickSaveFile(
    title: string,
    defaultPath?: string,
    filters?: readonly FileFilter[],
  ): Promise<string | null> {
    return this.bridge.invoke<string | null>('plugin:dialog|save', {
      options: { title, defaultPath, filters },
    });
  }
}

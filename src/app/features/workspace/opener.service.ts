/**
 * OS opener — workspace path / repo folder in the file explorer (§2, §6) and
 * detected service URLs in the browser (§6 right-click → remote URL, card log
 * port line).
 *
 * INTEGRATION NOTE: ipc-contract.md §2 does not (yet) define opener commands.
 * The Rust shell ships `tauri-plugin-opener`, whose commands are reachable
 * through the regular invoke channel under the plugin namespace. This service
 * is the single place those names live; if the contract later adds first-class
 * `open_path`/`open_url` commands, swap them here only.
 */
import { Injectable } from '@angular/core';

import { TauriBridge } from '../../core/ipc/tauri-bridge';

@Injectable({ providedIn: 'root' })
export class OpenerService {
  constructor(private readonly bridge: TauriBridge) {}

  /** Open a directory/file in the OS file manager (v1 `os.startfile` & co.). */
  async openPath(path: string): Promise<void> {
    try {
      await this.bridge.invoke<void>('plugin:opener|open_path', { path });
    } catch (err: unknown) {
      console.error('open_path failed', path, err);
    }
  }

  /** Open a URL in the default browser (repo remote, localhost port link). */
  async openUrl(url: string): Promise<void> {
    try {
      await this.bridge.invoke<void>('plugin:opener|open_url', { url });
    } catch (err: unknown) {
      console.error('open_url failed', url, err);
    }
  }
}

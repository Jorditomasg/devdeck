/**
 * Launch-on-login toggle (DevDeck starts when you log into the OS).
 *
 * The OS is the SOURCE OF TRUTH — Windows `Run` registry key / Linux XDG
 * `~/.config/autostart/*.desktop`, both written by `tauri-plugin-autostart`.
 * We never mirror the flag in `AppConfig`: `isEnabled()` reads it back from the
 * OS, so there is no drift if the user removes the entry by hand.
 *
 * This thin wrapper exists so `features/` never imports the platform plugin
 * directly (layering) and the toggle stays mockable in specs.
 */
import { Injectable, signal } from '@angular/core';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';

@Injectable({ providedIn: 'root' })
export class AutostartStore {
  private readonly _enabled = signal(false);

  /** Whether DevDeck is currently registered for launch-on-login. */
  readonly enabled = this._enabled.asReadonly();

  /** Read the current OS registration into the signal. */
  async load(): Promise<boolean> {
    const on = await isEnabled();
    this._enabled.set(on);
    return on;
  }

  /** Register (`true`) or unregister (`false`) DevDeck for launch-on-login. */
  async set(value: boolean): Promise<void> {
    if (value) {
      await enable();
    } else {
      await disable();
    }
    this._enabled.set(value);
  }
}

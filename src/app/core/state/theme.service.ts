/**
 * Appearance preference — color palette + background pattern.
 *
 * Unlike language/tray (system state persisted through the Rust `ConfigStore`),
 * the theme is a PURE-UI preference with no side effect on the OS. It does not
 * round-trip through the IPC contract: it persists in `localStorage` and applies
 * via `data-palette` / `data-pattern` attributes on `<html>`, where the SCSS
 * (`styles/_themes.scss`, `styles/_pattern.scss`) does the rest by overriding
 * the `:root` design tokens.
 *
 * Cross-window sync comes for free: every DevDeck window is the same SPA at the
 * same origin, so the native `storage` event fires in EVERY OTHER window when
 * one of them writes the key — detached log/terminal/dialog windows re-apply
 * live without any Rust event plumbing.
 *
 * ponytail: localStorage + storage event over a Rust config field + IPC command
 * + contract bump — a visual toggle is not system state.
 */
import { Injectable, signal } from '@angular/core';

/** Color palettes (kebab values = the `[data-palette]` attribute). */
export const PALETTES = [
  'indigo',
  'slate',
  'emerald',
  'crimson',
  'rose',
  'light',
] as const;

/** Background patterns (kebab values = the `[data-pattern]` attribute). */
export const PATTERNS = [
  'cubes',
  'none',
  'grid',
  'dots',
  'arcs',
  'hexagons',
  'scales',
  'moroccan',
] as const;

export type Palette = (typeof PALETTES)[number];
export type Pattern = (typeof PATTERNS)[number];

const DEFAULT_PALETTE: Palette = 'indigo';
const DEFAULT_PATTERN: Pattern = 'cubes';
const PALETTE_KEY = 'devdeck.palette';
const PATTERN_KEY = 'devdeck.pattern';

/** A stored palette string, or the default when unknown/absent. */
export function coercePalette(value: string | null): Palette {
  return (PALETTES as readonly string[]).includes(value ?? '')
    ? (value as Palette)
    : DEFAULT_PALETTE;
}

/** A stored pattern string, or the default when unknown/absent. */
export function coercePattern(value: string | null): Pattern {
  return (PATTERNS as readonly string[]).includes(value ?? '')
    ? (value as Pattern)
    : DEFAULT_PATTERN;
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _palette = signal<Palette>(DEFAULT_PALETTE);
  private readonly _pattern = signal<Pattern>(DEFAULT_PATTERN);

  readonly palette = this._palette.asReadonly();
  readonly pattern = this._pattern.asReadonly();

  /**
   * Load the persisted choice and apply it. Called FIRST in the app
   * initializer (before `frontend_ready` shows the window) so there is no
   * flash of the default theme. Synchronous — reads localStorage, no IPC.
   */
  init(): void {
    this._palette.set(coercePalette(this.read(PALETTE_KEY)));
    this._pattern.set(coercePattern(this.read(PATTERN_KEY)));
    this.apply();
    // `storage` fires in OTHER windows when one persists a change → live sync.
    window.addEventListener('storage', (e) => {
      if (e.key === PALETTE_KEY) {
        this._palette.set(coercePalette(e.newValue));
        this.apply();
      } else if (e.key === PATTERN_KEY) {
        this._pattern.set(coercePattern(e.newValue));
        this.apply();
      }
    });
  }

  setPalette(palette: Palette): void {
    this._palette.set(palette);
    this.write(PALETTE_KEY, palette);
    this.apply();
  }

  setPattern(pattern: Pattern): void {
    this._pattern.set(pattern);
    this.write(PATTERN_KEY, pattern);
    this.apply();
  }

  private apply(): void {
    const el = document.documentElement;
    el.setAttribute('data-palette', this._palette());
    el.setAttribute('data-pattern', this._pattern());
  }

  private read(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null; // storage disabled — fall back to defaults
    }
  }

  private write(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // storage disabled — change still applies live for this window
    }
  }
}

/**
 * Translation runtime — signal-based port of v1 `core/i18n.py`
 * (inventory-config-ci.md §2):
 * - Catalogs: `assets/i18n/{en,es}.json` — nested JSON addressed by
 *   dot-namespaced keys (`dialog.merge.title`), 410 leaf keys per language.
 * - Interpolation: `{placeholder}` (v1 `str.format_map`); unknown
 *   placeholders are left verbatim (never throw — v1 swallowed errors).
 * - Plurals: NO ICU — explicit `*_one` / `*_many` key pairs
 *   (e.g. `dialog.confirm_close.message_one|message_many`), see {@link tn}.
 * - Fallback chain: active language → `en` → the key itself (v1 always
 *   loaded the `en_EN` catalog as fallback, config-ci §2.1).
 * - Persistence: the v1 config key `language` stores `en_EN`/`es_ES`; this
 *   service maps those codes to the v2 asset names (`en`/`es`) and persists
 *   through `SettingsStore`. Unlike v1 (restart required), v2 applies the
 *   language live — every `t()` call reads the language signal, so zoneless
 *   change detection re-renders automatically.
 */
import { Injectable, computed, signal } from '@angular/core';

import { SettingsStore } from '../state/settings.store';

/** v2 catalog codes (asset file basenames). */
export type LanguageCode = 'en' | 'es';

/** Interpolation parameters for `{placeholder}` substitution. */
export type TranslateParams = Readonly<Record<string, string | number>>;

/** Nested translation catalog (the parsed assets/i18n/<lang>.json). */
export interface Catalog {
  readonly [key: string]: string | Catalog;
}

/** Languages shipped in v2 (assets/i18n/). */
export const SUPPORTED_LANGUAGES: readonly LanguageCode[] = ['en', 'es'];

/** The always-loaded fallback catalog language (v1 `en_EN` semantics). */
export const FALLBACK_LANGUAGE: LanguageCode = 'en';

/** Map a v1 config code (`es_ES`) to a v2 catalog code; unknown ⇒ `en`. */
export function normalizeLanguage(v1Code: string | undefined): LanguageCode {
  const short = (v1Code ?? '').slice(0, 2).toLowerCase();
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(short)
    ? (short as LanguageCode)
    : FALLBACK_LANGUAGE;
}

/** Map a v2 catalog code back to the persisted v1 config code. */
export function toV1LanguageCode(lang: LanguageCode): string {
  return lang === 'es' ? 'es_ES' : 'en_EN';
}

/** Resolve a dot-namespaced key inside a nested catalog. */
function lookup(catalog: Catalog | undefined, key: string): string | undefined {
  if (!catalog) {
    return undefined;
  }
  let node: string | Catalog | undefined = catalog;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) {
      return undefined;
    }
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** `{placeholder}` interpolation; unknown placeholders stay verbatim. */
function interpolate(template: string, params?: TranslateParams): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

@Injectable({ providedIn: 'root' })
export class TranslationService {
  private readonly _language = signal<LanguageCode>(FALLBACK_LANGUAGE);
  private readonly _catalogs = signal<
    Partial<Record<LanguageCode, Catalog>>
  >({});

  /** Active catalog language. */
  readonly language = this._language.asReadonly();

  /** True once the active-language catalog is available. */
  readonly ready = computed(
    () => this._catalogs()[this._language()] !== undefined,
  );

  /**
   * Catalog loader — replaceable in unit tests (no TestBed / fetch mocking
   * needed). Default: fetch from the bundled assets.
   */
  catalogLoader: (lang: LanguageCode) => Promise<Catalog> = async (lang) => {
    const response = await fetch(`assets/i18n/${lang}.json`);
    if (!response.ok) {
      throw new Error(`failed to load i18n catalog '${lang}': ${response.status}`);
    }
    return (await response.json()) as Catalog;
  };

  constructor(private readonly settings: SettingsStore) {}

  /**
   * Load the persisted language (+ the `en` fallback catalog). Called from
   * the app initializer AFTER `SettingsStore.load()`. Loader failures are
   * swallowed per catalog — the fallback chain still yields keys, and the
   * app must boot even with broken assets (v1 resilience contract).
   */
  async init(): Promise<void> {
    const lang = normalizeLanguage(this.settings.language());
    await this.activate(lang, false);
  }

  /** Switch language live and persist the v1 code via the settings store. */
  async setLanguage(lang: LanguageCode): Promise<void> {
    await this.activate(lang, true);
  }

  /**
   * Translate a dot-namespaced key with `{placeholder}` interpolation.
   * Fallback chain: active → `en` → the key itself (config-ci §2.1).
   */
  t(key: string, params?: TranslateParams): string {
    const catalogs = this._catalogs();
    const template =
      lookup(catalogs[this._language()], key) ??
      lookup(catalogs[FALLBACK_LANGUAGE], key) ??
      key;
    return interpolate(template, params);
  }

  /**
   * Plural helper for the v1 explicit-pair convention: resolves
   * `<baseKey>_one` when `count === 1`, else `<baseKey>_many`, always
   * passing `{count}` as an interpolation param (the `_many` messages use
   * it; `_one` messages embed the literal "1").
   */
  tn(baseKey: string, count: number, params?: TranslateParams): string {
    const suffix = count === 1 ? 'one' : 'many';
    return this.t(`${baseKey}_${suffix}`, { count, ...params });
  }

  private async activate(lang: LanguageCode, persist: boolean): Promise<void> {
    const wanted = new Set<LanguageCode>([lang, FALLBACK_LANGUAGE]);
    const loaded = this._catalogs();
    for (const code of wanted) {
      if (loaded[code]) {
        continue;
      }
      try {
        const catalog = await this.catalogLoader(code);
        this._catalogs.update((c) => ({ ...c, [code]: catalog }));
      } catch {
        // Missing/broken catalog: keep the fallback chain functional.
      }
    }
    this._language.set(lang);
    if (persist) {
      await this.settings.setLanguage(toV1LanguageCode(lang));
    }
  }
}

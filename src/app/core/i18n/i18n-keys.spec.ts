/**
 * Catalog guards (CLAUDE.md i18n rule):
 *
 * 1. PARITY — `en.json` and `es.json` must keep an IDENTICAL key structure.
 * 2. NO ORPHANS — every key must be referenced somewhere in `src/app`.
 *    Keys built at runtime (`t(\`label.status.${status}\`)`) can't be found
 *    verbatim, so their prefixes are whitelisted below. Add a prefix ONLY
 *    for a genuinely dynamic call site — never to park dead keys.
 *
 * TestBed-free like every spec here; plain node fs over the source tree.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import en from '../../../assets/i18n/en.json';
import es from '../../../assets/i18n/es.json';

/** Dynamic-key call sites (template-literal `t()` calls) — keep in sync. */
const DYNAMIC_PREFIXES = [
  /^label\.status\./, // repo-card + docker dialog: t(`label.status.${status}`)
  /^dialog\.settings\.palette_/, // settings: t(`dialog.settings.palette_${p}`)
  /^dialog\.settings\.pattern_/, // settings: t(`dialog.settings.pattern_${p}`)
  /^dialog\.settings\.language_/, // settings: t(`dialog.settings.language_${code}`)
  // tn() plural pairs: the call site names the BASE key only
  // (confirm-close: tn('dialog.confirm_close.message', count)).
  /^dialog\.confirm_close\.message_(one|many)$/,
];

function flatten(catalog: object, prefix = ''): string[] {
  return Object.entries(catalog).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null ? flatten(value, path) : [path];
  });
}

function readTree(dir: string): string {
  return readdirSync(dir)
    .map((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        return readTree(path);
      }
      return /\.(ts|html)$/.test(entry) ? readFileSync(path, 'utf8') : '';
    })
    .join('\n');
}

describe('i18n catalogs', () => {
  const enKeys = flatten(en);
  const esKeys = flatten(es);

  it('en and es expose the identical key set', () => {
    const esSet = new Set(esKeys);
    const enSet = new Set(enKeys);
    expect(enKeys.filter((k) => !esSet.has(k))).toEqual([]);
    expect(esKeys.filter((k) => !enSet.has(k))).toEqual([]);
  });

  it('every key is referenced in src/app (or matches a dynamic prefix)', () => {
    // cwd = repo root (vitest runs from the package root).
    const source = readTree(join(process.cwd(), 'src/app'));
    const orphans = enKeys.filter(
      (key) => !source.includes(key) && !DYNAMIC_PREFIXES.some((p) => p.test(key)),
    );
    expect(orphans).toEqual([]);
  });
});

#!/usr/bin/env node
// Compares the key structure of en.json and es.json. Exits 1 listing any divergence.
import { readFileSync } from 'node:fs';

const load = (lang) =>
  JSON.parse(readFileSync(new URL(`../src/assets/i18n/${lang}.json`, import.meta.url), 'utf8'));

const keysOf = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keysOf(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );

const en = new Set(keysOf(load('en')));
const es = new Set(keysOf(load('es')));
const missingInEs = [...en].filter((k) => !es.has(k));
const missingInEn = [...es].filter((k) => !en.has(k));

if (missingInEs.length || missingInEn.length) {
  if (missingInEs.length) console.error(`Missing in es.json:\n  ${missingInEs.join('\n  ')}`);
  if (missingInEn.length) console.error(`Missing in en.json:\n  ${missingInEn.join('\n  ')}`);
  process.exit(1);
}
console.log(`i18n OK: ${en.size} keys in sync`);

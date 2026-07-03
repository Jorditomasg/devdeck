/**
 * File-extension → CodeMirror 6 language mapping (git suite phase 1).
 *
 * ONE decision point for the whole suite: the diff viewer's full-file view
 * now, the conflict editor in phase 4. Languages cover the stacks DevDeck
 * manages (design doc §6): TS/JS (Angular, React, Nx), Java (Spring Boot),
 * Rust, and the config/markup formats around them. Unknown extensions
 * render as plain text (`null`).
 */
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import type { LanguageSupport } from '@codemirror/language';

const BY_EXTENSION: Readonly<Record<string, () => LanguageSupport>> = {
  ts: () => javascript({ typescript: true }),
  mts: () => javascript({ typescript: true }),
  cts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  java: () => java(),
  rs: () => rust(),
  html: () => html(),
  htm: () => html(),
  css: () => css(),
  // ponytail: scss through the css mode — close enough for read-only
  // viewing; swap for a real scss mode if phase 4 editing needs it.
  scss: () => css(),
  json: () => json(),
  yaml: () => yaml(),
  yml: () => yaml(),
  xml: () => xml(),
  svg: () => xml(),
  md: () => markdown(),
  py: () => python(),
};

/** File extension (lowercased, no dot) — `''` for dotless names. */
export function extensionOf(fileName: string): string {
  const base = fileName.split('/').pop() ?? '';
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(idx + 1).toLowerCase() : '';
}

/** CodeMirror language for a file, or `null` → plain text. */
export function languageFor(fileName: string): LanguageSupport | null {
  const factory = BY_EXTENSION[extensionOf(fileName)];
  return factory ? factory() : null;
}

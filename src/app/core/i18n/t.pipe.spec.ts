/** TestBed-free specs (vitest-style; runner wiring is a later task). */
import { describe, expect, it } from 'vitest';

import { CMD, IpcCommands } from '../ipc/commands';
import { IpcEvents } from '../ipc/events';
import { FakeTauriBridge } from '../ipc/tauri-bridge.fake';
import { SettingsStore } from '../state/settings.store';
import { TPipe } from './t.pipe';
import { TranslationService, type Catalog, type LanguageCode } from './translation.service';

const EN: Catalog = { btn: { start: '▶ Start' }, label: { java_recommended: 'Recommended: Java {version}' } };
const ES: Catalog = { btn: { start: '▶ Iniciar' } };

async function makePipe(): Promise<{ pipe: TPipe; i18n: TranslationService }> {
  const bridge = new FakeTauriBridge().whenInvoked(CMD.getAppConfig, {
    language: 'en_EN',
  });
  const settings = new SettingsStore(new IpcCommands(bridge), new IpcEvents(bridge));
  await settings.load();
  const i18n = new TranslationService(settings, new IpcEvents(bridge));
  i18n.catalogLoader = (lang: LanguageCode) =>
    Promise.resolve(lang === 'es' ? ES : EN);
  await i18n.init();
  return { pipe: new TPipe(i18n), i18n };
}

describe('TPipe', () => {
  it('translates keys with optional params', async () => {
    const { pipe } = await makePipe();
    expect(pipe.transform('btn.start')).toBe('▶ Start');
    expect(pipe.transform('label.java_recommended', { version: '21' })).toBe(
      'Recommended: Java 21',
    );
  });

  it('reflects a live language switch (impure + signal-driven CD)', async () => {
    const { pipe, i18n } = await makePipe();
    expect(pipe.transform('btn.start')).toBe('▶ Start');

    await i18n.setLanguage('es');

    // The impure pipe re-runs on the CD pass scheduled by the language
    // signal; calling transform again models that pass.
    expect(pipe.transform('btn.start')).toBe('▶ Iniciar');
  });
});

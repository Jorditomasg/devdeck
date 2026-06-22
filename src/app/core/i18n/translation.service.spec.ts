/** TestBed-free specs (vitest-style; runner wiring is a later task). */
import { describe, expect, it } from 'vitest';

import { CMD, IpcCommands } from '../ipc/commands';
import { EVT, IpcEvents } from '../ipc/events';
import { FakeTauriBridge } from '../ipc/tauri-bridge.fake';
import { SettingsStore } from '../state/settings.store';
import {
  TranslationService,
  normalizeLanguage,
  toV1LanguageCode,
  type Catalog,
  type LanguageCode,
} from './translation.service';

const EN: Catalog = {
  btn: { start: '▶ Start' },
  label: {
    java_recommended: 'Recommended: Java {version}',
    status: { running_port: 'Running :{port}' },
  },
  dialog: {
    confirm_close: {
      message_one: 'There is 1 service running.',
      message_many: 'There are {count} services running.',
    },
  },
  only_in_en: 'english only',
};

const ES: Catalog = {
  btn: { start: '▶ Iniciar' },
  label: {
    java_recommended: 'Recomendado: Java {version}',
    status: { running_port: 'Ejecutando :{port}' },
  },
  dialog: {
    confirm_close: {
      message_one: 'Hay 1 servicio en ejecución.',
      message_many: 'Hay {count} servicios en ejecución.',
    },
  },
};

async function makeService(persistedLanguage?: string): Promise<{
  service: TranslationService;
  bridge: FakeTauriBridge;
}> {
  const bridge = new FakeTauriBridge().whenInvoked(CMD.getAppConfig, {
    language: persistedLanguage,
  });
  const settings = new SettingsStore(new IpcCommands(bridge), new IpcEvents(bridge));
  await settings.load();
  const service = new TranslationService(settings, new IpcEvents(bridge));
  service.catalogLoader = (lang: LanguageCode) =>
    lang === 'es' ? Promise.resolve(ES) : Promise.resolve(EN);
  await service.init();
  return { service, bridge };
}

describe('language code mapping (v1 ↔ v2)', () => {
  it('normalizes v1 codes to catalog codes, defaulting to en', () => {
    expect(normalizeLanguage('es_ES')).toBe('es');
    expect(normalizeLanguage('en_EN')).toBe('en');
    expect(normalizeLanguage(undefined)).toBe('en');
    expect(normalizeLanguage('fr_FR')).toBe('en');
  });

  it('round-trips back to persisted v1 codes', () => {
    expect(toV1LanguageCode('es')).toBe('es_ES');
    expect(toV1LanguageCode('en')).toBe('en_EN');
  });
});

describe('TranslationService', () => {
  it('resolves nested dot-namespaced keys', async () => {
    const { service } = await makeService('en_EN');
    expect(service.t('btn.start')).toBe('▶ Start');
    expect(service.language()).toBe('en');
    expect(service.ready()).toBe(true);
  });

  it('interpolates {placeholder} params (v1 format_map semantics)', async () => {
    const { service } = await makeService('en_EN');
    expect(service.t('label.java_recommended', { version: '17' })).toBe(
      'Recommended: Java 17',
    );
    expect(service.t('label.status.running_port', { port: 8080 })).toBe(
      'Running :8080',
    );
  });

  it('leaves unknown placeholders verbatim (never throws)', async () => {
    const { service } = await makeService('en_EN');
    expect(service.t('label.java_recommended')).toBe('Recommended: Java {version}');
    expect(service.t('label.java_recommended', { other: 'x' })).toBe(
      'Recommended: Java {version}',
    );
  });

  it('plural helper picks _one / _many explicit pairs', async () => {
    const { service } = await makeService('en_EN');
    expect(service.tn('dialog.confirm_close.message', 1)).toBe(
      'There is 1 service running.',
    );
    expect(service.tn('dialog.confirm_close.message', 3)).toBe(
      'There are 3 services running.',
    );
  });

  it('falls back active → en → key itself (config-ci §2.1 chain)', async () => {
    const { service } = await makeService('es_ES');
    expect(service.t('btn.start')).toBe('▶ Iniciar'); // active
    expect(service.t('only_in_en')).toBe('english only'); // en fallback
    expect(service.t('does.not.exist')).toBe('does.not.exist'); // key itself
  });

  it('init() activates the persisted v1 language', async () => {
    const { service } = await makeService('es_ES');
    expect(service.language()).toBe('es');
  });

  it('setLanguage switches live and persists the v1 code', async () => {
    const { service, bridge } = await makeService('en_EN');

    await service.setLanguage('es');

    expect(service.t('btn.start')).toBe('▶ Iniciar');
    expect(bridge.invokesOf(CMD.setLanguage)[0]?.args).toEqual({
      language: 'es_ES',
    });
  });

  it('re-activates on config://changed without re-persisting (cross-window)', async () => {
    // A detached window seeds 'en' at boot; another window then switches to
    // Spanish. The broadcast must retranslate THIS window's signal — and must
    // NOT call set_language again (no save loop).
    const { service, bridge } = await makeService('en_EN');
    expect(service.language()).toBe('en');

    bridge.emit(EVT.configChanged, { language: 'es_ES' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.language()).toBe('es');
    expect(service.t('btn.start')).toBe('▶ Iniciar');
    expect(bridge.invokesOf(CMD.setLanguage)).toHaveLength(0);
  });

  it('survives a broken catalog (fallback chain stays functional)', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.getAppConfig, {
      language: 'es_ES',
    });
    const settings = new SettingsStore(new IpcCommands(bridge), new IpcEvents(bridge));
    await settings.load();
    const service = new TranslationService(settings, new IpcEvents(bridge));
    service.catalogLoader = (lang: LanguageCode) =>
      lang === 'es'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(EN);

    await service.init();

    expect(service.language()).toBe('es');
    expect(service.t('btn.start')).toBe('▶ Start'); // en fallback
  });
});

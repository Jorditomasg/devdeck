import { describe, expect, it } from 'vitest';

import type { RepoInfo, ServiceStatus } from '../../../core/ipc/tauri.types';
import {
  buildPanelServices,
  isRunning,
  runningIds,
  selectedRepos,
  stoppedIds,
  type SelectionMap,
} from './tray-panel.logic';

/** Minimal RepoInfo stub — only the fields the panel logic reads. */
function repo(name: string, extra: Partial<RepoInfo> = {}): RepoInfo {
  return { name, path: `/ws/${name}`, repoType: 'spring', ...extra } as unknown as RepoInfo;
}

const SELECTION: SelectionMap = {
  api: { selected: true },
  web: { selected: true },
  infra: { selected: false },
};

describe('selectedRepos', () => {
  it('keeps repos unless explicitly deselected (default = selected)', () => {
    const repos = [repo('api'), repo('web'), repo('infra'), repo('unknown')];
    // infra is selected:false → out; api/web true → in; unknown has no entry
    // (never toggled) → in by default.
    expect(selectedRepos(repos, SELECTION).map((r) => r.name)).toEqual(['api', 'web', 'unknown']);
  });
});

describe('isRunning', () => {
  it('treats running/starting/stopping as running, stopped/error as not', () => {
    expect(['running', 'starting', 'stopping'].every((s) => isRunning(s as ServiceStatus))).toBe(
      true,
    );
    expect(['stopped', 'error', 'installing'].some((s) => isRunning(s as ServiceStatus))).toBe(
      false,
    );
  });
});

describe('buildPanelServices', () => {
  const repos = [repo('api', { contextPath: 'api' }), repo('web'), repo('infra')];
  const status = (id: string): ServiceStatus => (id === 'api' ? 'running' : 'stopped');
  const port = (id: string): number | undefined => (id === 'api' ? 8080 : undefined);

  it('rows are the selected repos in order, with a clickable url only when running', () => {
    const rows = buildPanelServices(repos, SELECTION, status, port);
    expect(rows.map((r) => r.id)).toEqual(['api', 'web']);
    expect(rows[0]).toMatchObject({ status: 'running', port: 8080, url: 'http://localhost:8080/api' });
    expect(rows[1]).toMatchObject({ status: 'stopped', url: null });
  });

  it('splits start-all (stopped) and stop-all (running) targets', () => {
    const rows = buildPanelServices(repos, SELECTION, status, port);
    expect(runningIds(rows)).toEqual(['api']);
    expect(stoppedIds(rows)).toEqual(['web']);
  });
});

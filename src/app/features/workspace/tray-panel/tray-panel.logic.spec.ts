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
  return {
    name,
    path: `/ws/${name}`,
    repoType: 'spring',
    features: [],
    dockerComposeFiles: [],
    ...extra,
  } as unknown as RepoInfo;
}

/** A docker-managed repo: the `docker_checkboxes` feature + compose files. */
function dockerRepo(name: string, files = [`/ws/${name}/docker-compose.yml`]): RepoInfo {
  return repo(name, {
    repoType: 'docker-infra',
    features: ['docker_checkboxes'],
    dockerComposeFiles: files,
  });
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

  it('orders rows like the main window: persisted order first, alphabetical baseline', () => {
    // web dragged to the top (order -1); api/unknown keep alphabetical rank.
    const selection: SelectionMap = { web: { order: -1 }, infra: { selected: false } };
    const rows = buildPanelServices([...repos, repo('unknown')], selection, status, port);
    expect(rows.map((r) => r.id)).toEqual(['web', 'api', 'unknown']);
  });

  it('splits start-all (stopped) and stop-all (running) targets', () => {
    const rows = buildPanelServices(repos, SELECTION, status, port);
    expect(runningIds(rows)).toEqual(['api']);
    expect(stoppedIds(rows)).toEqual(['web']);
  });

  it('takes a docker repo status from the container count, not the process registry', () => {
    const rows = buildPanelServices([dockerRepo('stack')], {}, status, port, { stack: 2 });
    // `status()` would say `stopped` — a docker repo has no supervised process.
    expect(rows[0]).toMatchObject({ status: 'running' });
    expect(rows[0]?.composeFiles).toEqual(['/ws/stack/docker-compose.yml']);
    expect(runningIds(rows)).toEqual(['stack']);
  });

  it('reports a docker repo with no running containers as stopped', () => {
    const rows = buildPanelServices([dockerRepo('stack')], {}, status, port, {});
    expect(rows[0]).toMatchObject({ status: 'stopped' });
    expect(stoppedIds(rows)).toEqual(['stack']);
  });

  it('leaves composeFiles empty for a process repo, so it keeps the process branch', () => {
    const rows = buildPanelServices([repo('api')], {}, status, port);
    expect(rows[0]?.composeFiles).toEqual([]);
  });
});

/** TestBed-free specs (vitest-style; runner wiring is a later task). */
import { describe, expect, it } from 'vitest';

import { CMD, IpcCommands } from './commands';
import { FakeTauriBridge } from './tauri-bridge.fake';

describe('CMD registry', () => {
  it('contains the 101 contract commands, all snake_case and unique', () => {
    // 86 prior + show_main_window / request_quit (tray quick-control panel)
    // + whats_new_on_startup / disable_whats_new (post-update popup)
    // + open_git_window / git_log / git_commit_files / git_commit_file_diff
    //   / git_file_at_commit / git_working_diff (git suite phase 1)
    // + git_authors (phase 2 author filter)
    // + git_diff_range / git_diff_range_file (phase 3 compare view)
    // + git_ls_files / git_commit_body (path autocomplete + full message).
    const names = Object.values(CMD);
    expect(names.length).toBe(101);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('IpcCommands wrappers', () => {
  it('routes through the bridge with the contract names and camelCase args', async () => {
    const bridge = new FakeTauriBridge()
      .whenInvoked(CMD.gitPull, { ok: true, message: 'up to date' })
      .whenInvoked(CMD.scanWorkspace, []);
    const api = new IpcCommands(bridge);

    const result = await api.git.pull('/ws/api');
    await api.detection.scanWorkspace(['/ws']);
    await api.process.stopService('api::root');
    await api.config.setActiveConfig('api::root', null);

    expect(result).toEqual({ ok: true, message: 'up to date' });
    expect(bridge.invokes.map((i) => i.command)).toEqual([
      'git_pull',
      'scan_workspace',
      'stop_service',
      'set_active_config',
    ]);
    expect(bridge.invokesOf(CMD.gitPull)[0]?.args).toEqual({
      repoPath: '/ws/api',
    });
    expect(bridge.invokesOf(CMD.setActiveConfig)[0]?.args).toEqual({
      configKey: 'api::root',
      name: null,
    });
  });

  it('merge wrappers carry the request/revert payloads verbatim', async () => {
    const bridge = new FakeTauriBridge();
    const api = new IpcCommands(bridge);
    const request = { source: 'develop', targetMode: 'new', newBranch: 'merge/x' } as const;
    const revertPoint = {
      mode: 'new',
      original_branch: 'develop',
      new_branch: 'merge/x',
    } as const;

    await api.git.merge('/ws/api', request);
    await api.git.revertMerge('/ws/api', revertPoint);

    expect(bridge.invokesOf(CMD.gitMerge)[0]?.args).toEqual({
      repoPath: '/ws/api',
      request,
    });
    expect(bridge.invokesOf(CMD.gitRevertMerge)[0]?.args).toEqual({
      repoPath: '/ws/api',
      revertPoint,
    });
  });

  it('stash wrappers carry the payloads verbatim', async () => {
    const bridge = new FakeTauriBridge();
    const api = new IpcCommands(bridge);

    await api.git.stashList('/ws/api');
    await api.git.stashPush('/ws/api', 'pre-merge', true);
    await api.git.stashPush('/ws/api', null, false);
    await api.git.stashApply('/ws/api', 0);
    await api.git.stashPop('/ws/api', 1);
    await api.git.stashDrop('/ws/api', 2);

    expect(bridge.invokesOf(CMD.gitStashList)[0]?.args).toEqual({ repoPath: '/ws/api' });
    expect(bridge.invokesOf(CMD.gitStashPush)[0]?.args).toEqual({
      repoPath: '/ws/api',
      message: 'pre-merge',
      includeUntracked: true,
    });
    expect(bridge.invokesOf(CMD.gitStashPush)[1]?.args).toEqual({
      repoPath: '/ws/api',
      message: null,
      includeUntracked: false,
    });
    expect(bridge.invokesOf(CMD.gitStashApply)[0]?.args).toEqual({ repoPath: '/ws/api', index: 0 });
    expect(bridge.invokesOf(CMD.gitStashPop)[0]?.args).toEqual({ repoPath: '/ws/api', index: 1 });
    expect(bridge.invokesOf(CMD.gitStashDrop)[0]?.args).toEqual({ repoPath: '/ws/api', index: 2 });
  });

  it('branch-management wrappers carry the payloads verbatim', async () => {
    const bridge = new FakeTauriBridge();
    const api = new IpcCommands(bridge);

    await api.git.createBranch('/ws/api', 'feature/x', 'main', true);
    await api.git.deleteBranch('/ws/api', 'old', false);
    await api.git.deleteRemoteBranch('/ws/api', 'old');
    await api.git.renameBranch('/ws/api', null, 'renamed');
    await api.git.publishBranch('/ws/api', 'feature/x');

    expect(bridge.invokesOf(CMD.gitCreateBranch)[0]?.args).toEqual({
      repoPath: '/ws/api',
      name: 'feature/x',
      base: 'main',
      checkout: true,
    });
    expect(bridge.invokesOf(CMD.gitDeleteBranch)[0]?.args).toEqual({
      repoPath: '/ws/api',
      name: 'old',
      force: false,
    });
    expect(bridge.invokesOf(CMD.gitDeleteRemoteBranch)[0]?.args).toEqual({
      repoPath: '/ws/api',
      name: 'old',
    });
    expect(bridge.invokesOf(CMD.gitRenameBranch)[0]?.args).toEqual({
      repoPath: '/ws/api',
      from: null,
      to: 'renamed',
    });
    expect(bridge.invokesOf(CMD.gitPublishBranch)[0]?.args).toEqual({
      repoPath: '/ws/api',
      name: 'feature/x',
    });
  });

  it('history wrappers carry the payloads verbatim (git suite phase 1)', async () => {
    const bridge = new FakeTauriBridge();
    const api = new IpcCommands(bridge);
    const filter = { branch: 'develop', author: 'jordi', skip: 50 } as const;

    await api.git.openWindow('api', 'api — Git');
    await api.git.openWindow('api', 'api — Git', { tab: 'stashes', stash: 1 });
    await api.git.authors('/ws/api');
    await api.git.log('/ws/api', filter);
    await api.git.commitFiles('/ws/api', 'abc123');
    await api.git.commitFileDiff('/ws/api', 'abc123', 'src/main.rs');
    await api.git.fileAtCommit('/ws/api', 'abc123', 'src/main.rs');
    await api.git.workingDiff('/ws/api', 'src/main.rs', true);

    expect(bridge.invokesOf(CMD.openGitWindow)[0]?.args).toEqual({
      repoId: 'api',
      title: 'api — Git',
    });
    expect(bridge.invokesOf(CMD.openGitWindow)[1]?.args).toEqual({
      repoId: 'api',
      title: 'api — Git',
      tab: 'stashes',
      stash: 1,
    });
    expect(bridge.invokesOf(CMD.gitAuthors)[0]?.args).toEqual({ repoPath: '/ws/api' });

    await api.git.diffRange('/ws/api', 'main', 'origin/main');
    await api.git.diffRangeFile('/ws/api', 'main', 'origin/main', 'src/x.ts');
    expect(bridge.invokesOf(CMD.gitDiffRange)[0]?.args).toEqual({
      repoPath: '/ws/api',
      base: 'main',
      target: 'origin/main',
    });
    expect(bridge.invokesOf(CMD.gitDiffRangeFile)[0]?.args).toEqual({
      repoPath: '/ws/api',
      base: 'main',
      target: 'origin/main',
      path: 'src/x.ts',
    });

    await api.git.lsFiles('/ws/api');
    await api.git.commitBody('/ws/api', 'abc123');
    await api.git.tags('/ws/api');
    expect(bridge.invokesOf(CMD.gitTags)[0]?.args).toEqual({ repoPath: '/ws/api' });
    expect(bridge.invokesOf(CMD.gitLsFiles)[0]?.args).toEqual({ repoPath: '/ws/api' });
    expect(bridge.invokesOf(CMD.gitCommitBody)[0]?.args).toEqual({
      repoPath: '/ws/api',
      sha: 'abc123',
    });
    expect(bridge.invokesOf(CMD.gitLog)[0]?.args).toEqual({
      repoPath: '/ws/api',
      filter,
    });
    expect(bridge.invokesOf(CMD.gitCommitFiles)[0]?.args).toEqual({
      repoPath: '/ws/api',
      sha: 'abc123',
    });
    expect(bridge.invokesOf(CMD.gitCommitFileDiff)[0]?.args).toEqual({
      repoPath: '/ws/api',
      sha: 'abc123',
      path: 'src/main.rs',
    });
    expect(bridge.invokesOf(CMD.gitFileAtCommit)[0]?.args).toEqual({
      repoPath: '/ws/api',
      sha: 'abc123',
      path: 'src/main.rs',
    });
    expect(bridge.invokesOf(CMD.gitWorkingDiff)[0]?.args).toEqual({
      repoPath: '/ws/api',
      path: 'src/main.rs',
      staged: true,
    });
  });

  it('propagates command rejections (AppError shape)', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.importProfile, () => {
      throw { kind: 'profile', message: "missing 'repos' key" };
    });
    const api = new IpcCommands(bridge);

    await expect(api.profiles.importProfile('/tmp/x.json')).rejects.toEqual({
      kind: 'profile',
      message: "missing 'repos' key",
    });
  });
});

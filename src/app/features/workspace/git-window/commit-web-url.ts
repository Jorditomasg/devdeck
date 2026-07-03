/**
 * Commit → forge web URL (git suite phase 3): derive the "view this commit
 * on the repository's website" link from the git remote URL. Pure — no IPC.
 *
 * Supported shapes: https remotes (with/without `.git`, with credentials)
 * and scp-like ssh remotes (`git@host:owner/repo.git`). Per-forge commit
 * path: GitHub/Gitea/Forgejo/Azure use `/commit/`, GitLab `/-/commit/`,
 * Bitbucket `/commits/`. Unknown hosts fall back to `/commit/` (the most
 * common convention).
 */

/** Normalize a git remote into a browsable https base URL ('' when not derivable). */
export function remoteWebBase(remote: string): string {
  let url = remote.trim();
  if (url === '') {
    return '';
  }
  // scp-like ssh: git@host:owner/repo(.git) → https://host/owner/repo.
  // The host must look like one (contains a dot) and the path must be
  // POSIX — otherwise Windows paths like `C:\repos\local` would match.
  const scp = /^(?:[\w.-]+@)?([\w-]+(?:\.[\w-]+)+):(?!\d)([^\\]+)$/.exec(url);
  if (!url.includes('://') && scp) {
    url = `https://${scp[1]}/${scp[2]}`;
  } else if (url.startsWith('ssh://')) {
    // ssh://git@host[:port]/owner/repo
    url = url.replace(/^ssh:\/\/(?:[\w.-]+@)?/, 'https://').replace(/:\d+\//, '/');
  } else if (url.startsWith('http://') || url.startsWith('https://')) {
    // strip credentials: https://user:token@host/… → https://host/…
    url = url.replace(/^(https?:\/\/)[^/@]+@/, '$1');
  } else {
    return ''; // file paths, bundles, unsupported transports
  }
  return url.replace(/\.git\/?$/, '').replace(/\/+$/, '');
}

/** Web URL of one commit, or '' when the remote is not browsable. */
export function commitWebUrl(remote: string, sha: string): string {
  const base = remoteWebBase(remote);
  if (base === '' || sha === '') {
    return '';
  }
  const host = base.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
  if (host.includes('gitlab')) {
    return `${base}/-/commit/${sha}`;
  }
  if (host.includes('bitbucket')) {
    return `${base}/commits/${sha}`;
  }
  return `${base}/commit/${sha}`;
}

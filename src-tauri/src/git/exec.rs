//! Git subprocess execution — the only place this module spawns processes.
//!
//! Mirrors v1's `_run_git_command` (inventory-backend.md §10): no shell,
//! `cwd=repo_path`, UTF-8 with lossy replacement, per-command timeout from
//! the v1 table (§21.5), `CREATE_NO_WINDOW` on Windows. Parsing lives in
//! [`super::parse`] so it stays pure and unit-testable.
//!
//! WSL routing (Windows only): a repo addressed through a WSL UNC share
//! (`\\wsl.localhost\<distro>\...` or legacy `\\wsl$\...`) runs the DISTRO's
//! git via `wsl.exe --exec` — native ext4 speed instead of Windows git over
//! the 9P bridge. `--exec` (not `--`) is deliberate: it preserves argv
//! without a shell, so refs/messages can never be shell-interpreted.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use super::types::GitError;

/// v1 timeout table for git (inventory-backend.md §10, §21.5), in seconds.
pub(crate) const T_QUERY: u64 = 10; // status/branch/reflog/diff queries
pub(crate) const T_FAST: u64 = 5; // rev-parse / rev-list / remote get-url
pub(crate) const T_BRANCH_OP: u64 = 30; // checkout / reset / clean / branch -D / merge --abort
pub(crate) const T_FETCH: u64 = 60; // git fetch --all --prune (badge refresh path)
pub(crate) const T_FETCH_QUIET: u64 = 30; // git fetch --quiet
pub(crate) const T_LONG: u64 = 120; // pull / merge / push / merge-pipeline fetch

/// Captured output of a finished git command.
#[derive(Debug)]
pub(crate) struct GitOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

impl GitOutput {
    /// `stdout + "\n" + stderr`, trimmed — v1's combined-message convention.
    pub fn combined(&self) -> String {
        format!("{}\n{}", self.stdout, self.stderr).trim().to_string()
    }

    /// v1's `(stderr or stdout).strip()` error-message preference.
    pub fn error_message(&self) -> String {
        let err = self.stderr.trim();
        if err.is_empty() { self.stdout.trim().to_string() } else { err.to_string() }
    }
}

/// A repo living inside a WSL distro, addressed from Windows via its UNC
/// share. `linux_path` is absolute inside the distro (`/home/...`).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct WslPath {
    pub distro: String,
    pub linux_path: String,
}

/// [`parse_wsl_path`] on Windows; always `None` elsewhere — Linux builds
/// never reroute (a Unix path can't be a WSL UNC share anyway).
pub(crate) fn wsl_path_for(path: &Path) -> Option<WslPath> {
    #[cfg(windows)]
    return parse_wsl_path(path);
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

/// Parse `\\wsl.localhost\<distro>\<rest>` (or legacy `\\wsl$\...`, or the
/// verbatim `\\?\UNC\...` form) into distro + absolute Linux path. `None` for
/// anything else — drive letters, other UNC shares, Unix paths.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_wsl_path(path: &Path) -> Option<WslPath> {
    let s = path.to_str()?.replace('/', "\\");
    // Try the verbatim prefix FIRST — `\\?\UNC\...` also starts with `\\`.
    let rest = s.strip_prefix(r"\\?\UNC\").or_else(|| s.strip_prefix(r"\\"))?;
    let mut parts = rest.splitn(3, '\\');
    let server = parts.next()?;
    if !server.eq_ignore_ascii_case("wsl.localhost") && !server.eq_ignore_ascii_case("wsl$") {
        return None;
    }
    let distro = parts.next()?;
    let tail = parts.next()?;
    if distro.is_empty() || tail.trim_end_matches('\\').is_empty() {
        return None; // distro root is not a repo
    }
    Some(WslPath {
        distro: distro.to_string(),
        linux_path: format!("/{}", tail.trim_end_matches('\\').replace('\\', "/")),
    })
}

/// The base `git` invocation for `repo`: the distro's git through
/// `wsl.exe --exec` when the repo lives on a WSL share, plain `git` with
/// `cwd=repo` otherwise. Callers append the git args.
fn git_command(repo: &Path) -> Command {
    #[cfg(windows)]
    if let Some(wsl) = wsl_path_for(repo) {
        let mut cmd = Command::new("wsl.exe");
        // WSL_UTF8: wsl.exe's OWN diagnostics (bad distro, --cd failure) are
        // UTF-16 by default; force UTF-8 so they survive from_utf8_lossy.
        cmd.args(["-d", &wsl.distro, "--cd", &wsl.linux_path, "--exec", "git"])
            .env("WSL_UTF8", "1");
        return cmd;
    }
    let mut cmd = Command::new("git");
    cmd.current_dir(repo);
    cmd
}

/// Run `git <args>` in `repo` with a timeout. The child is killed if the
/// timeout elapses (`kill_on_drop`).
pub(crate) async fn run_git(
    repo: &Path,
    args: &[&str],
    timeout_secs: u64,
) -> Result<GitOutput, GitError> {
    let mut cmd = git_command(repo);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // CREATE_NO_WINDOW — every v1 subprocess uses it (inventory §21.5).
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output())
        .await
        .map_err(|_| GitError::Timeout(timeout_secs))?
        .map_err(|e| GitError::Spawn(e.to_string()))?;

    Ok(GitOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Run a MUTATING git command and fold the result into [`OpOutput`], logging
/// the combined output (the v1 `(ok, message)` idiom). Shared by the
/// stash/branch operation surfaces so they never duplicate the fold logic.
pub(crate) async fn run_logged_op(
    repo: &Path,
    args: &[&str],
    timeout_secs: u64,
    log: Option<&super::types::LogSink>,
) -> super::types::OpOutput {
    use super::types::{emit, OpOutput};
    let name = repo_name(repo);
    match run_git(repo, args, timeout_secs).await {
        Ok(out) if out.success => {
            let msg = out.combined();
            if !msg.is_empty() {
                emit(log, &format!("[git] {name}: {msg}"));
            }
            OpOutput::ok(msg)
        }
        Ok(out) => {
            let msg = out.error_message();
            emit(log, &format!("[git] {name}: {msg}"));
            OpOutput::fail(msg)
        }
        Err(err) => {
            let msg = err.to_string();
            emit(log, &format!("[git] {name}: {msg}"));
            OpOutput::fail(msg)
        }
    }
}

/// A ref/URL argument git would parse as an option (a leading `-`, e.g.
/// `--upload-pack=<cmd>`). Guarded at every public entry point that forwards an
/// untrusted ref, branch, or clone URL to git, so a value can never be promoted
/// to a flag (argument injection). See `branch.rs` for why a uniform `--`
/// end-of-options guard is not always usable.
pub(crate) fn is_option_like(value: &str) -> bool {
    value.starts_with('-')
}

/// Repo display name = directory basename (v1 `os.path.basename(repo_path)`).
pub(crate) fn repo_name(repo: &Path) -> String {
    repo.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| repo.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::{is_option_like, parse_wsl_path};
    use std::path::Path;

    /// `(distro, linux_path)` or `None` — thin harness over the parser.
    fn parse(s: &str) -> Option<(String, String)> {
        parse_wsl_path(Path::new(s)).map(|w| (w.distro, w.linux_path))
    }

    #[test]
    fn parses_wsl_localhost_share() {
        assert_eq!(
            parse(r"\\wsl.localhost\Ubuntu\home\jordi\api"),
            Some(("Ubuntu".into(), "/home/jordi/api".into()))
        );
    }

    #[test]
    fn parses_legacy_wsl_dollar_share() {
        assert_eq!(
            parse(r"\\wsl$\Debian\srv\app"),
            Some(("Debian".into(), "/srv/app".into()))
        );
    }

    #[test]
    fn parses_verbatim_unc_form() {
        // std::fs::canonicalize yields this form on Windows.
        assert_eq!(
            parse(r"\\?\UNC\wsl.localhost\Ubuntu\home\jordi\api"),
            Some(("Ubuntu".into(), "/home/jordi/api".into()))
        );
    }

    #[test]
    fn normalizes_forward_slashes_and_trailing_separator() {
        assert_eq!(
            parse(r"//wsl.localhost/Ubuntu/home/jordi/api/"),
            Some(("Ubuntu".into(), "/home/jordi/api".into()))
        );
    }

    #[test]
    fn server_match_is_case_insensitive() {
        assert_eq!(
            parse(r"\\WSL.LOCALHOST\Ubuntu\home\x"),
            Some(("Ubuntu".into(), "/home/x".into()))
        );
    }

    #[test]
    fn rejects_non_wsl_paths() {
        assert_eq!(parse(r"C:\proyectos\api"), None); // drive letter
        assert_eq!(parse(r"\\fileserver\share\repo"), None); // other UNC
        assert_eq!(parse(r"\\?\C:\proyectos\api"), None); // verbatim drive
        assert_eq!(parse("/home/jordi/api"), None); // unix path
        assert_eq!(parse(r"\\wsl.localhost\Ubuntu"), None); // distro root
        assert_eq!(parse(r"\\wsl.localhost\Ubuntu\"), None); // distro root
        assert_eq!(parse(r"\\wsl.localhost\\home\x"), None); // empty distro
    }

    #[test]
    fn flags_leading_dash_as_option_like() {
        // Argument-injection guard: these would be parsed as git flags.
        assert!(is_option_like("--upload-pack=touch pwned"));
        assert!(is_option_like("-x"));
        // Legitimate refs / URLs must pass.
        assert!(!is_option_like("main"));
        assert!(!is_option_like("feature/x"));
        assert!(!is_option_like("https://github.com/a/b.git"));
    }
}

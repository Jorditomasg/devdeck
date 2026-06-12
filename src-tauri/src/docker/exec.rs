//! Docker subprocess execution — the only place this module spawns
//! processes.
//!
//! Mirrors v1 `db_manager.py` conventions (inventory-backend.md §9, §21.5):
//! no shell, `capture_output`, UTF-8 lossy decoding, per-command timeout,
//! `CREATE_NO_WINDOW` on Windows. Compose commands run with
//! `cwd = dirname(compose_file)` and `-f basename` exactly like v1.
//!
//! Modernization (architecture-v2.md §2): compose is invoked through the v2
//! `docker compose` CLI when available, falling back to the legacy
//! `docker-compose` binary v1 always used. The probe runs once and is cached
//! for the process lifetime.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::OnceCell;

use super::types::DockerError;

/// v1 timeout table for docker (inventory-backend.md §9, §21.5), in seconds.
pub(crate) const T_QUERY: u64 = 10; // info / ps / compose ps / logs
pub(crate) const T_UP: u64 = 120; // compose up -d
pub(crate) const T_DOWN: u64 = 60; // compose down / stop

/// Captured output of a finished docker command.
#[derive(Debug)]
pub(crate) struct DockerOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

impl DockerOutput {
    /// `stdout.strip() + "\n" + stderr.strip()`, trimmed — v1's combined
    /// message convention.
    pub fn combined(&self) -> String {
        format!("{}\n{}", self.stdout.trim(), self.stderr.trim())
            .trim()
            .to_string()
    }
}

/// Which compose front-end this machine has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ComposeFlavor {
    /// `docker compose …` (compose v2 plugin).
    DockerCompose2,
    /// Legacy standalone `docker-compose …` (what v1 always used).
    LegacyBinary,
}

static COMPOSE_FLAVOR: OnceCell<ComposeFlavor> = OnceCell::const_new();

/// Probe `docker compose version` once; on failure fall back to the legacy
/// `docker-compose` binary.
pub(crate) async fn compose_flavor() -> ComposeFlavor {
    *COMPOSE_FLAVOR
        .get_or_init(|| async {
            match run_raw("docker", &["compose", "version"], None, T_QUERY).await {
                Ok(out) if out.success => ComposeFlavor::DockerCompose2,
                _ => ComposeFlavor::LegacyBinary,
            }
        })
        .await
}

/// Run a plain `docker <args>` command (queries: info, ps).
pub(crate) async fn run_docker(
    args: &[&str],
    timeout_secs: u64,
) -> Result<DockerOutput, DockerError> {
    run_raw("docker", args, None, timeout_secs).await
}

/// Run a compose command against `compose_file`:
/// `<compose> -f <basename> <args…>` with `cwd = dirname` (v1 convention —
/// compose project name derives from the directory).
pub(crate) async fn run_compose(
    compose_file: &Path,
    args: &[&str],
    timeout_secs: u64,
) -> Result<DockerOutput, DockerError> {
    let fname = compose_file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| compose_file.display().to_string());
    let cwd = compose_file.parent();

    let mut full: Vec<&str> = Vec::with_capacity(args.len() + 4);
    let program = match compose_flavor().await {
        ComposeFlavor::DockerCompose2 => {
            full.push("compose");
            "docker"
        }
        ComposeFlavor::LegacyBinary => "docker-compose",
    };
    full.push("-f");
    full.push(&fname);
    full.extend_from_slice(args);

    run_raw(program, &full, cwd, timeout_secs).await
}

async fn run_raw(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    timeout_secs: u64,
) -> Result<DockerOutput, DockerError> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    // CREATE_NO_WINDOW — every v1 subprocess uses it (inventory §21.5).
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output())
        .await
        .map_err(|_| DockerError::Timeout(timeout_secs))?
        .map_err(|e| DockerError::Spawn(e.to_string()))?;

    Ok(DockerOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pin the §21.5 docker timeout table.
    #[test]
    fn timeout_table_matches_v1() {
        assert_eq!(T_QUERY, 10, "docker queries 10 s");
        assert_eq!(T_UP, 120, "compose up 120 s");
        assert_eq!(T_DOWN, 60, "compose down/stop 60 s");
    }
}

//! Shell resolution for new terminals (design doc §"Shell, cwd").
//!
//! `terminal_argv` picks what a new terminal spawns: a repo inside WSL opens
//! its own distro's shell (`wsl.exe -d <distro> --cd <path>`), anything else
//! the user's Settings override (`AppConfig::terminal_shell`) or the
//! per-platform `default_shell`. `detect_shells` lists the shells found on
//! THIS machine for the Settings picker — probed at runtime, never assumed.

use std::path::PathBuf;
#[cfg(unix)]
use std::path::Path;

use serde::Serialize;

use crate::wsl::WslPath;

/// One shell offered in the Settings picker. `command` is what gets spawned
/// (an executable name resolvable on `PATH`, or an absolute path); `label` is
/// the human-friendly name shown in the list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub label: String,
    pub command: String,
}

/// Resolve the shell to spawn: the Settings override when set and non-empty,
/// else the per-platform [`default_shell`].
pub fn resolve_shell(override_shell: Option<&str>) -> String {
    match override_shell {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => default_shell(),
    }
}

/// A WSL repo ignores the override: a Windows shell can't run the distro's
/// toolchain, so the terminal matches what the repo's services do (`wsl.rs`).
pub fn terminal_argv(wsl: Option<&WslPath>, override_shell: Option<&str>) -> Vec<String> {
    match wsl {
        Some(w) => ["wsl.exe", "-d", w.distro.as_str(), "--cd", w.linux_path.as_str()]
            .map(str::to_string)
            .to_vec(),
        None => vec![resolve_shell(override_shell)],
    }
}

/// The shell to spawn for a new terminal.
/// - Unix: `$SHELL` when set and non-empty, else `/bin/bash` if present, else
///   `/bin/sh`.
/// - Windows: `pwsh.exe` when on `PATH`, else `powershell.exe`.
pub fn default_shell() -> String {
    #[cfg(unix)]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            if !shell.trim().is_empty() {
                return shell;
            }
        }
        if Path::new("/bin/bash").exists() {
            return "/bin/bash".to_string();
        }
        "/bin/sh".to_string()
    }
    #[cfg(windows)]
    {
        if find_on_path("pwsh.exe").is_some() {
            "pwsh.exe".to_string()
        } else {
            "powershell.exe".to_string()
        }
    }
}

/// Shells available on THIS machine, for the Settings picker. Each candidate
/// is probed (on `PATH` or at a well-known absolute path) and only included
/// when actually present. The returned `command` is what a terminal spawns.
pub fn detect_shells() -> Vec<ShellInfo> {
    let mut out: Vec<ShellInfo> = Vec::new();
    let mut push = |label: &str, command: String| {
        // Resolved-path dedupe: usrmerge lists both `/bin/bash` and `/usr/bin/bash`.
        let real = |c: &str| std::fs::canonicalize(c).unwrap_or_else(|_| PathBuf::from(c));
        if !out.iter().any(|s| real(&s.command) == real(&command)) {
            out.push(ShellInfo {
                label: label.to_string(),
                command,
            });
        }
    };

    #[cfg(windows)]
    {
        // Candidates resolvable on PATH.
        for (label, exe) in [
            ("PowerShell 7 (pwsh)", "pwsh.exe"),
            ("Windows PowerShell", "powershell.exe"),
            ("Command Prompt (cmd)", "cmd.exe"),
            ("WSL", "wsl.exe"),
        ] {
            if find_on_path(exe).is_some() {
                push(label, exe.to_string());
            }
        }
        // Git Bash sits at `<Git>\bin\bash.exe`, `git.exe` at `<Git>\cmd`
        // or `<Git>\mingw64\bin`. Never probe `bash.exe` on PATH: that is
        // System32's WSL launcher.
        let from_git: Vec<PathBuf> = find_on_path("git.exe")
            .and_then(|git| git.parent().map(|d| d.ancestors().take(3).map(PathBuf::from).collect()))
            .unwrap_or_default();
        let roots = ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(|dir| PathBuf::from(dir).join("Git"));
        for root in from_git.into_iter().chain(roots) {
            let bash = root.join("bin").join("bash.exe");
            if bash.is_file() {
                push("Git Bash", bash.to_string_lossy().into_owned());
            }
        }
    }

    #[cfg(unix)]
    {
        // `$SHELL` first (the user's login shell), then the common ones.
        if let Ok(shell) = std::env::var("SHELL") {
            if !shell.trim().is_empty() && Path::new(shell.trim()).exists() {
                let label = shell_label(shell.trim());
                push(&format!("{label} (login)"), shell.trim().to_string());
            }
        }
        let listed = std::fs::read_to_string("/etc/shells").ok();
        let candidates: Vec<PathBuf> = match listed.as_deref() {
            Some(text) => parse_etc_shells(text).into_iter().map(PathBuf::from).collect(),
            None => ["bash", "zsh", "fish", "sh"]
                .into_iter()
                .filter_map(find_on_path)
                .collect(),
        };
        for path in candidates.into_iter().filter(|p| p.is_file()) {
            let path = path.to_string_lossy().into_owned();
            push(&shell_label(&path), path);
        }
    }

    out
}

#[cfg(unix)]
fn parse_etc_shells(text: &str) -> Vec<&str> {
    text.lines()
        .map(str::trim)
        .filter(|l| l.starts_with('/'))
        .collect()
}

/// Title-case-ish label for a shell from its executable name/path.
#[cfg(unix)]
fn shell_label(path: &str) -> String {
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => name,
    }
}

/// First `PATH` entry containing `exe`, if any.
fn find_on_path(exe: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(exe))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wsl_repo_opens_its_own_distro_and_ignores_the_override() {
        let w = WslPath {
            distro: "Ubuntu-24.04".into(),
            linux_path: "/home/me/api".into(),
        };
        assert_eq!(
            terminal_argv(Some(&w), Some("pwsh.exe")),
            ["wsl.exe", "-d", "Ubuntu-24.04", "--cd", "/home/me/api"]
        );
    }

    #[test]
    fn a_native_repo_uses_the_override_or_the_default() {
        assert_eq!(terminal_argv(None, Some(" cmd.exe ")), ["cmd.exe"]);
        assert_eq!(terminal_argv(None, Some("  ")), [default_shell()]);
        assert_eq!(terminal_argv(None, None), [default_shell()]);
    }

    #[cfg(unix)]
    #[test]
    fn etc_shells_keeps_only_absolute_paths() {
        let text = "# /etc/shells: valid login shells\n/bin/sh\n\n  /usr/bin/zsh \nnot-a-path\n";
        assert_eq!(parse_etc_shells(text), ["/bin/sh", "/usr/bin/zsh"]);
    }
}

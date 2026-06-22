//! Shell resolution for new terminals (design doc §"Shell, cwd").
//!
//! `default_shell` is the per-platform fallback; `resolve_shell` applies the
//! user's Settings override (`AppConfig::terminal_shell`); `detect_shells`
//! lists the shells found on this machine for the Settings picker.

use std::path::PathBuf;
#[cfg(unix)]
use std::path::Path;

use serde::Serialize;

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
        // Dedup by command so the same shell isn't listed twice.
        if !out.iter().any(|s| s.command == command) {
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
        // Git Bash — not usually on PATH; probe the standard install paths.
        for base in ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"] {
            if let Some(dir) = std::env::var_os(base) {
                let bash = PathBuf::from(dir).join("Git").join("bin").join("bash.exe");
                if bash.is_file() {
                    push("Git Bash", bash.to_string_lossy().into_owned());
                }
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
        for exe in ["bash", "zsh", "fish", "sh"] {
            if let Some(path) = find_on_path(exe) {
                push(&shell_label(exe), path.to_string_lossy().into_owned());
            }
        }
    }

    out
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

//! Default shell resolution for new terminals (design doc §"Shell, cwd").
//!
//! A global config override is out of scope for this first cut (YAGNI); this
//! resolves a sensible per-platform default.

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
        if std::path::Path::new("/bin/bash").exists() {
            return "/bin/bash".to_string();
        }
        "/bin/sh".to_string()
    }
    #[cfg(windows)]
    {
        if which_on_path("pwsh.exe") {
            "pwsh.exe".to_string()
        } else {
            "powershell.exe".to_string()
        }
    }
}

/// True when `exe` is found in any `PATH` entry (Windows shell preference).
#[cfg(windows)]
fn which_on_path(exe: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(exe).is_file()))
        .unwrap_or(false)
}

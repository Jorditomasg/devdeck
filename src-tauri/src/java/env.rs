//! Launch-environment builder for Java services
//! (v1 `build_java_env`, core/java_manager.py, inventory-backend.md §13).
//!
//! v1 cloned the whole `os.environ`; v2's `process::ServiceSpec.env` carries
//! **overrides** applied on top of the inherited environment, so this builder
//! returns just the two keys that change: `JAVA_HOME` and a `PATH` with
//! `<home>/bin` prepended (separator `;` on Windows, `:` on POSIX).

use std::collections::HashMap;
use std::path::Path;

/// Platform PATH separator (v1: `;` on Windows, `:` on POSIX).
pub const PATH_SEPARATOR: char = if cfg!(windows) { ';' } else { ':' };

/// Environment overrides for a service launched with the given JAVA_HOME:
/// `{JAVA_HOME: <home>, PATH: <home>/bin + sep + current PATH}`.
///
/// Empty map when `java_home` is empty or not a directory — v1 returned the
/// unmodified environment in that case (system-default Java).
pub fn build_java_env(java_home: &str) -> HashMap<String, String> {
    if java_home.is_empty() || !Path::new(java_home).is_dir() {
        return HashMap::new();
    }
    let current_path = std::env::var("PATH").unwrap_or_default();
    build_java_env_with(java_home, &current_path)
}

/// Pure core of [`build_java_env`] — takes the current `PATH` explicitly so
/// it is unit-testable without touching the process environment.
pub fn build_java_env_with(java_home: &str, current_path: &str) -> HashMap<String, String> {
    let bin_dir = Path::new(java_home).join("bin");
    let mut env = HashMap::new();
    env.insert("JAVA_HOME".to_string(), java_home.to_string());
    env.insert(
        "PATH".to_string(),
        format!("{}{}{}", bin_dir.display(), PATH_SEPARATOR, current_path),
    );
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepends_bin_to_path_with_platform_separator() {
        let home = if cfg!(windows) { r"C:\jdk-17" } else { "/opt/jdk-17" };
        let env = build_java_env_with(home, "/usr/bin");
        assert_eq!(env["JAVA_HOME"], home);
        let path = &env["PATH"];
        let bin = std::path::Path::new(home).join("bin");
        assert!(path.starts_with(&bin.display().to_string()), "bin dir first: {path}");
        assert!(path.ends_with("/usr/bin"));
        assert!(path.contains(PATH_SEPARATOR));
        assert_eq!(env.len(), 2, "only JAVA_HOME and PATH are overridden");
    }

    #[test]
    fn invalid_home_yields_no_overrides() {
        assert!(build_java_env("").is_empty());
        assert!(build_java_env("/definitely/not/a/dir/dm2").is_empty());
    }

    #[test]
    fn separator_matches_platform() {
        if cfg!(windows) {
            assert_eq!(PATH_SEPARATOR, ';');
        } else {
            assert_eq!(PATH_SEPARATOR, ':');
        }
    }
}

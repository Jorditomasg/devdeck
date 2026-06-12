//! JDK discovery — the async port of v1 `auto_detect_java_paths`
//! (core/java_manager.py, inventory-backend.md §13).
//!
//! Scans the platform base directories, validates each candidate by running
//! `<home>/bin/java -version` (2 s timeout, version printed on stderr), and
//! returns `{label → JAVA_HOME}` entries with v1's
//! `"Java {ver} ({dirname})"` labels. All failures are swallowed — an
//! invalid candidate is simply skipped, like v1.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use super::parse::{java_label, parse_java_version};

/// `java -version` timeout — "java -version 2 s" (inventory-backend.md §21.5).
pub const JAVA_VERSION_TIMEOUT: Duration = Duration::from_secs(2);

/// Platform-specific base directories where JDKs are commonly installed
/// (v1 `_java_search_paths`).
pub fn search_paths() -> Vec<PathBuf> {
    if cfg!(windows) {
        let mut paths = vec![
            PathBuf::from(r"C:\Program Files\Java"),
            PathBuf::from(r"C:\Program Files\Eclipse Adoptium"),
            PathBuf::from(r"C:\Program Files\Amazon Corretto"),
            PathBuf::from(r"C:\Program Files\Microsoft"),
            PathBuf::from(r"C:\Program Files\BellSoft"),
        ];
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join(".jdks"));
        }
        paths
    } else {
        let mut paths = vec![
            PathBuf::from("/usr/lib/jvm"),
            PathBuf::from("/Library/Java/JavaVirtualMachines"),
        ];
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join(".jdks"));
            paths.push(home.join(".sdkman/candidates/java"));
        }
        paths
    }
}

/// Resolve the JAVA_HOME for a JDK directory entry — on POSIX, when the base
/// is the macOS `JavaVirtualMachines` bundle dir, descend into
/// `<entry>/Contents/Home` if it exists (v1 `_jdk_home`).
fn jdk_home(base_dir: &Path, entry: &Path) -> PathBuf {
    if cfg!(unix) && base_dir.to_string_lossy().contains("JavaVirtualMachines") {
        let mac_home = entry.join("Contents").join("Home");
        if mac_home.is_dir() {
            return mac_home;
        }
    }
    entry.to_path_buf()
}

/// Path of the java executable under a JAVA_HOME.
fn java_exe(java_home: &Path) -> PathBuf {
    java_home
        .join("bin")
        .join(if cfg!(windows) { "java.exe" } else { "java" })
}

/// Run `<java_exe> -version` and extract the simplified version
/// (v1 `_get_java_version`): 2 s timeout, version usually on **stderr**
/// (stdout fallback). `None` on any failure.
pub async fn detect_java_version(java_exe: &Path) -> Option<String> {
    let mut cmd = Command::new(java_exe);
    cmd.arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = tokio::time::timeout(JAVA_VERSION_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let banner: &str = if stderr.trim().is_empty() {
        // v1: `result.stderr or result.stdout`.
        return parse_java_version(&String::from_utf8_lossy(&output.stdout));
    } else {
        &stderr
    };
    parse_java_version(banner)
}

/// Validate one candidate JAVA_HOME: `<home>/bin/java[.exe]` must be a file
/// AND `java -version` must yield a parsable version
/// (v1 `_java_label`). Returns `(label, home)` or `None`.
async fn validate_candidate(java_home: &Path, suffix: &str) -> Option<(String, String)> {
    let exe = java_exe(java_home);
    if !exe.is_file() {
        return None;
    }
    let version = detect_java_version(&exe).await?;
    Some((
        java_label(&version, suffix),
        java_home.to_string_lossy().into_owned(),
    ))
}

/// Auto-detect installed JDKs: `{label → JAVA_HOME path}`
/// (v1 `auto_detect_java_paths`). Also includes a valid `$JAVA_HOME` env
/// entry labelled `"Java {ver} (JAVA_HOME)"`. The settings dialog merges the
/// result into the persisted `java_versions` config key (skip when label OR
/// path already present — §13).
pub async fn auto_detect_java_paths() -> BTreeMap<String, String> {
    let mut found = BTreeMap::new();

    for base_dir in search_paths() {
        let Ok(entries) = std::fs::read_dir(&base_dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let dirname = entry.file_name().to_string_lossy().into_owned();
            let home = jdk_home(&base_dir, &path);
            if let Some((label, home)) = validate_candidate(&home, &dirname).await {
                found.insert(label, home);
            }
        }
    }

    // Also add JAVA_HOME if set and valid.
    if let Ok(env_home) = std::env::var("JAVA_HOME") {
        let env_home = PathBuf::from(env_home);
        if env_home.is_dir() {
            if let Some((label, home)) = validate_candidate(&env_home, "JAVA_HOME").await {
                found.insert(label, home);
            }
        }
    }

    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_timeout_is_two_seconds() {
        // §21.5: "java -version 2 s".
        assert_eq!(JAVA_VERSION_TIMEOUT.as_secs(), 2);
    }

    #[test]
    fn search_paths_are_platform_shaped() {
        let paths = search_paths();
        assert!(!paths.is_empty());
        if cfg!(windows) {
            assert!(paths.iter().any(|p| p.to_string_lossy().contains("Program Files")));
        } else {
            assert!(paths.iter().any(|p| p == &PathBuf::from("/usr/lib/jvm")));
            assert!(paths
                .iter()
                .any(|p| p == &PathBuf::from("/Library/Java/JavaVirtualMachines")));
        }
    }

    #[test]
    fn jdk_home_plain_entry_passthrough() {
        let base = PathBuf::from("/usr/lib/jvm");
        let entry = base.join("java-17-openjdk");
        assert_eq!(jdk_home(&base, &entry), entry);
    }

    #[tokio::test]
    async fn missing_java_exe_is_skipped() {
        let bogus = std::env::temp_dir().join("dm2-no-jdk-here");
        assert_eq!(validate_candidate(&bogus, "x").await, None);
    }
}

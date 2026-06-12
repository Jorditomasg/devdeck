//! Legacy-detector enrichments, merged into the ONE v2 detector.
//!
//! v1's main detection path never populated `RepoInfo.java_version`,
//! `server_port`, `context_path` or `git_remote_url` — those extractions
//! lived only in the broken legacy `core/repo_detector.py` (inventory-backend
//! .md §16, §22.4 "enrichment gap"). v2 merges them in
//! (architecture-v2.md §5):
//! - Java version from `pom.xml` (`<java.version>` /
//!   `<maven.compiler.source>` — regexes ported verbatim,
//!   repo_detector.py:185-201);
//! - static Spring `server.port` / `server.servlet.context-path` from the
//!   main application config (repo_detector.py:131-159);
//! - origin remote URL with the SSH→HTTPS conversion of v1
//!   `get_remote_url` (git_manager.py:301-317, §10.2) — read from
//!   `.git/config` directly instead of spawning git (subprocesses belong to
//!   the `git/` layer; detection stays filesystem-only).

use regex::Regex;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

/// `<java\.version>([^<]+)</java\.version>` — verbatim, repo_detector.py:192.
fn java_version_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<java\.version>([^<]+)</java\.version>").expect("static regex"))
}

/// `<maven\.compiler\.source>([^<]+)</maven\.compiler\.source>` — verbatim,
/// repo_detector.py:195.
fn maven_compiler_source_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"<maven\.compiler\.source>([^<]+)</maven\.compiler\.source>")
            .expect("static regex")
    })
}

/// Recommended Java version from raw pom.xml text: `<java.version>` first,
/// `<maven.compiler.source>` as fallback; captures trimmed (v1 parity).
pub fn extract_java_version_from_pom(pom: &str) -> Option<String> {
    java_version_re()
        .captures(pom)
        .or_else(|| maven_compiler_source_re().captures(pom))
        .map(|caps| caps[1].trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Java version for a repo: reads `<repo>/pom.xml`; any failure → `None`
/// (v1 swallowed everything, repo_detector.py:185-201).
pub fn java_version_for_repo(repo_root: &Path) -> Option<String> {
    let pom = repo_root.join("pom.xml");
    if !pom.is_file() {
        return None;
    }
    fs::read_to_string(&pom)
        .ok()
        .and_then(|text| extract_java_version_from_pom(&text))
}

/// Static Spring server info extracted from the main application config.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpringServerInfo {
    /// `server.port` (re-detected live from logs at runtime; this is only the
    /// static initial value).
    pub port: Option<u16>,
    /// `server.servlet.context-path`.
    pub context_path: Option<String>,
}

/// True when the basename is a main Spring config file
/// (repo_detector.py:52-69 looked for the first env file named
/// `application.yml|.yaml|.properties`).
pub fn is_main_spring_config(basename: &str) -> bool {
    matches!(
        basename,
        "application.yml" | "application.yaml" | "application.properties"
    )
}

/// Extract `server.port` / `server.servlet.context-path` from parsed YAML
/// (v1 `_extract_spring_server_info`, repo_detector.py:131-140: nested
/// `server:` mapping; falsy/absent values ignored).
pub fn extract_spring_server_info_yaml(text: &str) -> SpringServerInfo {
    let mut info = SpringServerInfo::default();
    let Ok(value) = serde_yaml_ng::from_str::<serde_yaml_ng::Value>(text) else {
        return info;
    };
    let Some(server) = value.get("server") else {
        return info;
    };
    info.port = server.get("port").and_then(yaml_port);
    info.context_path = server
        .get("servlet")
        .and_then(|s| s.get("context-path"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    info
}

/// Tolerate both `port: 8080` and `port: "8080"` (v1 called `int(port)`).
fn yaml_port(value: &serde_yaml_ng::Value) -> Option<u16> {
    if let Some(n) = value.as_u64() {
        return u16::try_from(n).ok();
    }
    value.as_str().and_then(|s| s.trim().parse().ok())
}

/// Extract server info from a `.properties` file: line-based, `#` comments
/// skipped, `key=value` split on the FIRST `=` (v1
/// `_extract_spring_info_from_props`, repo_detector.py:143-159).
pub fn extract_spring_server_info_props(text: &str) -> SpringServerInfo {
    let mut info = SpringServerInfo::default();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, val)) = line.split_once('=') else {
            continue;
        };
        let (key, val) = (key.trim(), val.trim());
        match key {
            // v1 aborted the whole parse on a non-numeric port (the int()
            // raise was swallowed by the enclosing try) — v2 just skips it.
            "server.port" => info.port = val.parse().ok(),
            "server.servlet.context-path" => {
                if !val.is_empty() {
                    info.context_path = Some(val.to_string());
                }
            }
            _ => {}
        }
    }
    info
}

/// Find the first main Spring config among the resolved env files and parse
/// it by extension (repo_detector.py:52-69). Non-Spring repos simply have no
/// `application.*` env file → default (empty) info.
pub fn spring_server_info(env_files: &[String]) -> SpringServerInfo {
    let Some(main) = env_files.iter().find(|f| {
        Path::new(f)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .is_some_and(|n| is_main_spring_config(&n))
    }) else {
        return SpringServerInfo::default();
    };
    let Ok(text) = fs::read_to_string(main) else {
        return SpringServerInfo::default();
    };
    if main.ends_with(".properties") {
        extract_spring_server_info_props(&text)
    } else {
        extract_spring_server_info_yaml(&text)
    }
}

/// Origin remote URL for a repo, read from `<repo>/.git/config`, with v1's
/// SSH→HTTPS conversion applied. Any failure → `None`.
pub fn git_remote_url(repo_root: &Path) -> Option<String> {
    let config = repo_root.join(".git").join("config");
    if !config.is_file() {
        return None;
    }
    let text = fs::read_to_string(&config).ok()?;
    parse_origin_url(&text).map(|url| normalize_remote_url(&url))
}

/// Extract `url` from the `[remote "origin"]` section of a git config file.
pub fn parse_origin_url(git_config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in git_config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            // git writes `[remote "origin"]`; tolerate inner spacing.
            in_origin = line.replace(' ', "") == r#"[remote"origin"]"#;
            continue;
        }
        if in_origin {
            if let Some((key, val)) = line.split_once('=') {
                if key.trim() == "url" {
                    let url = val.trim();
                    if !url.is_empty() {
                        return Some(url.to_string());
                    }
                }
            }
        }
    }
    None
}

/// v1 `get_remote_url` conversion (git_manager.py:301-317): SSH form only —
/// replace ALL `:` with `/`, `git@` → `https://`, strip trailing `.git`.
/// HTTPS URLs pass through untouched (including their `.git` suffix — v1
/// only stripped it inside the SSH branch).
pub fn normalize_remote_url(url: &str) -> String {
    let url = url.trim();
    if !url.starts_with("git@") {
        return url.to_string();
    }
    let mut converted = url.replace(':', "/").replace("git@", "https://");
    if let Some(stripped) = converted.strip_suffix(".git") {
        converted = stripped.to_string();
    }
    converted
}

#[cfg(test)]
mod tests {
    use super::*;

    const POM_JAVA_VERSION: &str = r#"<?xml version="1.0"?>
<project>
  <properties>
    <java.version> 17 </java.version>
    <maven.compiler.source>11</maven.compiler.source>
  </properties>
</project>"#;

    const POM_COMPILER_SOURCE_ONLY: &str = r#"<project>
  <properties>
    <maven.compiler.source>11</maven.compiler.source>
  </properties>
</project>"#;

    #[test]
    fn pom_java_version_wins_over_compiler_source_and_is_trimmed() {
        assert_eq!(
            extract_java_version_from_pom(POM_JAVA_VERSION),
            Some("17".into())
        );
        assert_eq!(
            extract_java_version_from_pom(POM_COMPILER_SOURCE_ONLY),
            Some("11".into())
        );
        assert_eq!(extract_java_version_from_pom("<project/>"), None);
    }

    #[test]
    fn spring_yaml_port_and_context_path() {
        let yml = "server:\n  port: 8085\n  servlet:\n    context-path: /api\nspring:\n  application:\n    name: demo\n";
        let info = extract_spring_server_info_yaml(yml);
        assert_eq!(info.port, Some(8085));
        assert_eq!(info.context_path.as_deref(), Some("/api"));

        // String port tolerated; missing servlet → no context path.
        let yml2 = "server:\n  port: \"9090\"\n";
        let info2 = extract_spring_server_info_yaml(yml2);
        assert_eq!(info2.port, Some(9090));
        assert_eq!(info2.context_path, None);

        // No server block / broken YAML → empty info, never panics.
        assert_eq!(extract_spring_server_info_yaml("a: 1"), SpringServerInfo::default());
        assert_eq!(
            extract_spring_server_info_yaml(":::{not yaml"),
            SpringServerInfo::default()
        );
    }

    #[test]
    fn spring_properties_port_and_context_path() {
        let props = "# comment\nserver.port=8443\nserver.servlet.context-path=/petclinic\nspring.datasource.url=jdbc:mysql://localhost/db\n";
        let info = extract_spring_server_info_props(props);
        assert_eq!(info.port, Some(8443));
        assert_eq!(info.context_path.as_deref(), Some("/petclinic"));

        // Non-numeric port skipped instead of aborting (v1 bug not ported).
        let info2 =
            extract_spring_server_info_props("server.port=${PORT}\nserver.servlet.context-path=/x");
        assert_eq!(info2.port, None);
        assert_eq!(info2.context_path.as_deref(), Some("/x"));
    }

    #[test]
    fn ssh_url_converted_https_passthrough() {
        // §10.2: replace ALL `:` with `/`, git@ → https://, strip .git.
        assert_eq!(
            normalize_remote_url("git@github.com:acme/widgets.git"),
            "https://github.com/acme/widgets"
        );
        assert_eq!(
            normalize_remote_url("git@gitlab.example.com:group/sub/repo.git"),
            "https://gitlab.example.com/group/sub/repo"
        );
        // HTTPS untouched (v1 only stripped .git in the SSH branch).
        assert_eq!(
            normalize_remote_url("https://github.com/acme/widgets.git"),
            "https://github.com/acme/widgets.git"
        );
    }

    #[test]
    fn parses_origin_url_from_git_config() {
        let cfg = r#"[core]
	repositoryformatversion = 0
	bare = false
[remote "upstream"]
	url = git@github.com:other/fork.git
[remote "origin"]
	url = git@github.com:acme/widgets.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "master"]
	remote = origin
"#;
        assert_eq!(
            parse_origin_url(cfg).as_deref(),
            Some("git@github.com:acme/widgets.git")
        );
        assert_eq!(parse_origin_url("[core]\n\tbare = false\n"), None);
    }

    #[test]
    fn spring_server_info_picks_first_main_config() {
        let dir = std::env::temp_dir().join(format!("dm2-enrich-{}-main", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("application.yml");
        std::fs::write(&main, "server:\n  port: 7001\n").unwrap();
        let files = vec![
            dir.join("application-dev.yml").display().to_string(), // not a MAIN config
            main.display().to_string(),
        ];
        let info = spring_server_info(&files);
        assert_eq!(info.port, Some(7001));
        // No application.* file at all → default.
        assert_eq!(spring_server_info(&[]), SpringServerInfo::default());
        let _ = std::fs::remove_dir_all(dir);
    }
}

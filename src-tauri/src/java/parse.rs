//! Pure parsing of `java -version` output — no process execution.
//!
//! Mirrors v1 `_get_java_version` (core/java_manager.py,
//! inventory-backend.md §13): the version is matched with
//! `(?:java|openjdk) version "([^"]+)"` and then simplified
//! (`1.8.0_311` → `8`, `17.0.2` → `17`).

use std::sync::OnceLock;

use regex::Regex;

fn version_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?:java|openjdk) version "([^"]+)""#).expect("static regex")
    })
}

/// Extract and simplify the Java version from `java -version` output
/// (the tool prints it on **stderr** usually; the caller passes
/// `stderr or stdout`). `None` when unparsable — v1 returned `""` and the
/// candidate JDK was skipped.
pub fn parse_java_version(output: &str) -> Option<String> {
    let raw = version_re().captures(output)?.get(1)?.as_str();
    Some(simplify_java_version(raw))
}

/// v1 simplification: legacy `1.x.y_z` versions take the SECOND dot segment
/// (`1.8.0_311` → `8`); modern versions take the first (`17.0.2` → `17`,
/// `21` → `21`).
pub fn simplify_java_version(raw: &str) -> String {
    let mut segments = raw.split('.');
    let first = segments.next().unwrap_or(raw);
    if first == "1" {
        segments.next().unwrap_or(first).to_string()
    } else {
        first.to_string()
    }
}

/// Display label for a detected JDK: `"Java {ver} ({dirname})"`
/// (v1 `_java_label` — `dirname` is the JDK directory entry, or the literal
/// `JAVA_HOME` for the env-var fallback).
pub fn java_label(version: &str, dirname: &str) -> String {
    format!("Java {version} ({dirname})")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_openjdk_modern() {
        let out = "openjdk version \"17.0.2\" 2022-01-18\nOpenJDK Runtime Environment (build 17.0.2+8-86)\nOpenJDK 64-Bit Server VM (build 17.0.2+8-86, mixed mode, sharing)\n";
        assert_eq!(parse_java_version(out), Some("17".to_string()));
    }

    #[test]
    fn parses_oracle_legacy_underscore() {
        let out = "java version \"1.8.0_311\"\nJava(TM) SE Runtime Environment (build 1.8.0_311-b11)\nJava HotSpot(TM) 64-Bit Server VM (build 25.311-b11, mixed mode)\n";
        assert_eq!(parse_java_version(out), Some("8".to_string()));
    }

    #[test]
    fn parses_single_segment_version() {
        let out = "openjdk version \"21\" 2023-09-19\nOpenJDK Runtime Environment (build 21+35-2513)\n";
        assert_eq!(parse_java_version(out), Some("21".to_string()));
    }

    #[test]
    fn unparsable_output_is_none() {
        assert_eq!(parse_java_version("not a java banner"), None);
        assert_eq!(parse_java_version(""), None);
        // Missing the `version "..."` quoting → no match.
        assert_eq!(parse_java_version("openjdk 17.0.2 2022-01-18"), None);
    }

    #[test]
    fn simplification_rules() {
        assert_eq!(simplify_java_version("1.8.0_311"), "8");
        assert_eq!(simplify_java_version("17.0.2"), "17");
        assert_eq!(simplify_java_version("21"), "21");
        assert_eq!(simplify_java_version("11.0.19"), "11");
    }

    #[test]
    fn label_format_matches_v1() {
        assert_eq!(java_label("17", "jdk-17"), "Java 17 (jdk-17)");
        assert_eq!(java_label("8", "JAVA_HOME"), "Java 8 (JAVA_HOME)");
    }
}

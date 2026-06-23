//! Pure parser for the root `CHANGELOG.md` (Keep a Changelog format).
//!
//! Side-effect-free: takes the file text, returns structured releases. The
//! file IO lives in `commands::updates::get_changelog`. The format is regular
//! enough that a hand parser beats pulling a markdown crate into the build.

use serde::Serialize;

/// One released (or unreleased) version block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogRelease {
    /// `"1.0.0"` or `"Unreleased"`.
    pub version: String,
    /// `"2026-06-21"`, or `None` for an Unreleased block / dateless heading.
    pub date: Option<String>,
    pub added: Vec<String>,
    pub changed: Vec<String>,
    pub fixed: Vec<String>,
    pub removed: Vec<String>,
}

impl ChangelogRelease {
    fn new(version: String, date: Option<String>) -> Self {
        Self {
            version,
            date,
            added: Vec::new(),
            changed: Vec::new(),
            fixed: Vec::new(),
            removed: Vec::new(),
        }
    }
}

#[derive(Clone, Copy)]
enum Section {
    Added,
    Changed,
    Fixed,
    Removed,
    Other,
}

/// Parse Keep-a-Changelog text into release blocks, newest first (document
/// order preserved). Headings that are not `## [version] - date` are ignored;
/// list items before the first version heading are dropped.
pub fn parse(text: &str) -> Vec<ChangelogRelease> {
    let mut releases: Vec<ChangelogRelease> = Vec::new();
    let mut section = Section::Other;

    for raw in text.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("## ") {
            if let Some((version, date)) = parse_version_heading(rest) {
                releases.push(ChangelogRelease::new(version, date));
                section = Section::Other;
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("### ") {
            section = match rest.trim().to_ascii_lowercase().as_str() {
                "added" => Section::Added,
                "changed" => Section::Changed,
                "fixed" => Section::Fixed,
                "removed" => Section::Removed,
                _ => Section::Other,
            };
            continue;
        }
        let Some(current) = releases.last_mut() else {
            continue;
        };
        let items = match section {
            Section::Added => &mut current.added,
            Section::Changed => &mut current.changed,
            Section::Fixed => &mut current.fixed,
            Section::Removed => &mut current.removed,
            Section::Other => continue,
        };
        if let Some(item) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            let text = item.trim().to_owned();
            if !text.is_empty() {
                items.push(text);
            }
        } else if !line.is_empty() {
            // Continuation of a hard-wrapped list item (Keep-a-Changelog
            // entries are wrapped for file readability) — fold into the current
            // item with a single space so the rendered bullet shows the full
            // sentence instead of dropping everything after the first line.
            if let Some(last) = items.last_mut() {
                last.push(' ');
                last.push_str(line);
            }
        }
    }
    releases
}

/// Parse the text after `## ` into `(version, date)`.
/// Accepts `[1.0.0] - 2026-06-21`, `[Unreleased]`, `1.0.0 - 2026-06-21`.
fn parse_version_heading(rest: &str) -> Option<(String, Option<String>)> {
    let rest = rest.trim();
    let (version_part, date_part) = match rest.split_once(" - ") {
        Some((v, d)) => (v.trim(), Some(d.trim().to_owned())),
        None => (rest, None),
    };
    let version = version_part
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim();
    if version.is_empty() {
        return None;
    }
    Some((version.to_owned(), date_part.filter(|d| !d.is_empty())))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
# Changelog

## [1.1.0] - 2026-07-01
### Added
- Dark mode
- Export profiles
### Fixed
- Crash on empty workspace

## [1.0.0] - 2026-06-21
### Added
- Auto-update from within the app
### Changed
- First stable release
";

    #[test]
    fn parses_versions_dates_and_sections() {
        let releases = parse(SAMPLE);
        assert_eq!(releases.len(), 2);

        assert_eq!(releases[0].version, "1.1.0");
        assert_eq!(releases[0].date.as_deref(), Some("2026-07-01"));
        assert_eq!(releases[0].added, vec!["Dark mode", "Export profiles"]);
        assert_eq!(releases[0].fixed, vec!["Crash on empty workspace"]);
        assert!(releases[0].changed.is_empty());

        assert_eq!(releases[1].version, "1.0.0");
        assert_eq!(releases[1].changed, vec!["First stable release"]);
    }

    #[test]
    fn handles_unreleased_and_dateless_headings() {
        let releases = parse("## [Unreleased]\n### Added\n- WIP feature\n");
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].version, "Unreleased");
        assert_eq!(releases[0].date, None);
        assert_eq!(releases[0].added, vec!["WIP feature"]);
    }

    #[test]
    fn ignores_items_before_first_version_and_empty_input() {
        assert!(parse("").is_empty());
        assert!(parse("# Changelog\n- stray bullet\n").is_empty());
    }

    #[test]
    fn folds_hard_wrapped_continuation_lines() {
        let releases = parse(
            "## [1.0.0]\n### Changed\n- Opening Settings now shows the update\n  automatically, without a click.\n- Second item\n",
        );
        assert_eq!(
            releases[0].changed,
            vec![
                "Opening Settings now shows the update automatically, without a click.",
                "Second item",
            ],
        );
    }

    #[test]
    fn ignores_unknown_sections() {
        let releases = parse("## [1.0.0]\n### Security\n- patched CVE\n");
        assert_eq!(releases.len(), 1);
        assert!(releases[0].added.is_empty());
        assert!(releases[0].changed.is_empty());
    }
}

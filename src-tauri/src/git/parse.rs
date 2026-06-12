//! Pure git-output parsers — no process execution, fully unit-testable.
//!
//! Each function implements the exact v1 parsing rules from
//! inventory-backend.md §10 (`core/git_manager.py`).

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

use super::types::StatusSummary;

/// Porcelain XY codes meaning "unmerged" (inventory-backend.md §10.2,
/// git_manager.py:14).
const UNMERGED_CODES: [&str; 7] = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];

fn behind_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"behind (\d+)").expect("static regex"))
}

fn reflog_checkout_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"checkout: moving from \S+ to (\S+)").expect("static regex"))
}

/// Parse `git branch --no-color` output (`_parse_local_branches`, §10.1):
/// strip, remove leading `* `, skip empty and detached-HEAD `(...)` lines.
pub fn parse_local_branches(output: &str) -> Vec<String> {
    output
        .lines()
        .map(|l| l.trim().trim_start_matches("* ").trim())
        .filter(|l| !l.is_empty() && !l.starts_with('('))
        .map(str::to_string)
        .collect()
}

/// Parse `git branch -r --no-color` output (`_parse_remote_branches`, §10.1):
/// skip `->` HEAD-alias lines, strip the FIRST `origin/` prefix only.
pub fn parse_remote_branches(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.contains("->"))
        .map(|l| match l.strip_prefix("origin/") {
            Some(rest) => rest.to_string(),
            None => l.to_string(),
        })
        .collect()
}

/// Parse `git reflog --format=%gs -n 300` output
/// (`get_recent_checked_out_branches`, §10.1): collect the checkout target of
/// every `checkout: moving from X to Y` entry, de-duplicated, most-recent
/// first (works for checkouts done by ANY tool).
pub fn parse_reflog_checkouts(output: &str) -> Vec<String> {
    let re = reflog_checkout_re();
    let mut seen: HashSet<String> = HashSet::new();
    let mut recent = Vec::new();
    for line in output.lines() {
        if let Some(caps) = re.captures(line) {
            let branch = caps[1].to_string();
            if seen.insert(branch.clone()) {
                recent.push(branch);
            }
        }
    }
    recent
}

/// `order_branches_by_recency` (§10.1), pure half: take up to `limit` recent
/// branches that exist in `branches` (preserving recency order), then the
/// remaining branches sorted alphabetically. Returns the ordered list and
/// `recent_count` — the index where the alphabetical section starts (the UI
/// draws a separator there).
pub fn order_branches_by_recency(
    recent: &[String],
    branches: &[String],
    limit: usize,
) -> (Vec<String>, usize) {
    let available: HashSet<&str> = branches.iter().map(String::as_str).collect();
    let mut ordered: Vec<String> = Vec::new();
    for branch in recent {
        if ordered.len() >= limit {
            break;
        }
        if available.contains(branch.as_str()) && !ordered.contains(branch) {
            ordered.push(branch.clone());
        }
    }
    let recent_count = ordered.len();
    let mut rest: Vec<String> = branches
        .iter()
        .filter(|b| !ordered.contains(b))
        .cloned()
        .collect();
    rest.sort();
    ordered.extend(rest);
    (ordered, recent_count)
}

/// Parse the `## <branch>...<upstream> [ahead N, behind M]` header line of
/// `git status --porcelain -b` (`_parse_status_branch_header`, §10.2):
/// branch = text before `...` and before the first space; `behind` via the
/// `behind (\d+)` regex.
pub fn parse_status_branch_header(line: &str) -> (String, u32) {
    let rest = line.trim_start_matches('#').trim_start();
    let branch = rest
        .split("...")
        .next()
        .unwrap_or("")
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();
    let behind = behind_re()
        .captures(rest)
        .and_then(|c| c[1].parse().ok())
        .unwrap_or(0);
    (branch, behind)
}

/// Tally one non-header porcelain line into the summary
/// (`_count_status_line`, §10.2):
/// - `??` → untracked → `unstaged += 1`
/// - XY in the unmerged set → `conflicts += 1`
/// - otherwise `X != ' '` → `staged += 1` AND `Y != ' '` → `unstaged += 1`
///   (a partially staged file counts in BOTH — keep parity, §22.19).
pub fn count_status_line(line: &str, summary: &mut StatusSummary) {
    let Some(code) = line.get(..2) else { return };
    if code == "??" {
        summary.unstaged += 1;
        return;
    }
    if UNMERGED_CODES.contains(&code) {
        summary.conflicts += 1;
        return;
    }
    let mut chars = code.chars();
    let (x, y) = (chars.next().unwrap_or(' '), chars.next().unwrap_or(' '));
    if x != ' ' {
        summary.staged += 1;
    }
    if y != ' ' {
        summary.unstaged += 1;
    }
}

/// Parse the full output of
/// `git --no-optional-locks status --porcelain -b --untracked-files=normal`
/// into the badge summary (`get_status_summary`, §10.2).
pub fn parse_status_porcelain(output: &str) -> StatusSummary {
    let mut summary = StatusSummary::default();
    for line in output.lines() {
        if line.starts_with("##") {
            let (branch, behind) = parse_status_branch_header(line);
            summary.branch = branch;
            summary.behind = behind;
        } else if !line.trim().is_empty() {
            count_status_line(line, &mut summary);
        }
    }
    summary
}

/// Extract local-change paths from `git status --porcelain
/// --untracked-files=all` output, excluding files whose **basename** matches
/// any glob in `ignore_patterns` (`get_local_changes`, §10.2 — used with
/// `env_pull_ignore_patterns` so managed config files don't count as dirty).
pub fn parse_local_changes(output: &str, ignore_patterns: &[String]) -> Vec<String> {
    output
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| l.get(3..))
        .map(str::to_string)
        .filter(|path| {
            let basename = path.rsplit('/').next().unwrap_or(path);
            !ignore_patterns.iter().any(|p| fnmatch(basename, p))
        })
        .collect()
}

/// Extract the progress percentage from a `git clone --progress` stderr line
/// (`_emit_clone_progress`, §10.3): the integer before the first `%` —
/// last whitespace token of the part before it.
/// e.g. `Receiving objects:  42% (123/290), 1.2 MiB | …` → `42`.
pub fn parse_clone_progress(line: &str) -> Option<u32> {
    let percent_pos = line.find('%')?;
    line[..percent_pos].split_whitespace().last()?.parse().ok()
}

/// Convert a remote URL for browser opening (`get_remote_url`, §10.2).
///
/// Delegates to [`crate::detection::enrich::normalize_remote_url`] — THE one
/// v1-verbatim normalizer (git_manager.py:301-317): SSH form only — replace
/// ALL `:` with `/`, `git@` → `https://`, strip trailing `.git`; HTTPS URLs
/// pass through UNTOUCHED (including their `.git` suffix — v1 only stripped
/// it inside the SSH branch). An earlier local variant here also stripped
/// `.git` from HTTPS, contradicting the detection layer; do not reintroduce.
pub fn remote_url_to_https(url: &str) -> String {
    crate::detection::enrich::normalize_remote_url(url)
}

/// Python-style `fnmatch.fnmatch` on a single name: `*`, `?` and `[...]`
/// wildcards, anchored to the whole string. Case-insensitive on Windows
/// (Python normalises case per OS).
pub fn fnmatch(name: &str, pattern: &str) -> bool {
    let regex_src = fnmatch_translate(pattern);
    Regex::new(&regex_src).map(|re| re.is_match(name)).unwrap_or(false)
}

/// Translate an fnmatch glob to an anchored regex (subset of Python's
/// `fnmatch.translate` covering `*`, `?`, `[seq]`, `[!seq]`).
fn fnmatch_translate(pattern: &str) -> String {
    let mut out = String::new();
    out.push_str(if cfg!(windows) { "(?si)^" } else { "(?s)^" });
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' => out.push_str(".*"),
            '?' => out.push('.'),
            '[' => {
                // Find the closing ']' with Python's rules: a ']' right after
                // '[' (or '[!') is a literal member of the class.
                let mut j = i + 1;
                if j < chars.len() && chars[j] == '!' {
                    j += 1;
                }
                if j < chars.len() && chars[j] == ']' {
                    j += 1;
                }
                while j < chars.len() && chars[j] != ']' {
                    j += 1;
                }
                if j >= chars.len() {
                    out.push_str(r"\[");
                } else {
                    let inner: String = chars[i + 1..j].iter().collect();
                    let inner = inner.replace('\\', r"\\");
                    out.push('[');
                    if let Some(rest) = inner.strip_prefix('!') {
                        out.push('^');
                        out.push_str(rest);
                    } else {
                        out.push_str(&inner);
                    }
                    out.push(']');
                    i = j;
                }
            }
            c => out.push_str(&regex::escape(&c.to_string())),
        }
        i += 1;
    }
    out.push('$');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- branch lists -------------------------------------------------

    #[test]
    fn local_branches_strip_current_marker_and_detached() {
        let output = "  develop\n* main\n  feature/login\n  (HEAD detached at 1a2b3c)\n\n";
        assert_eq!(
            parse_local_branches(output),
            vec!["develop", "main", "feature/login"]
        );
    }

    #[test]
    fn remote_branches_skip_head_alias_and_strip_first_origin_only() {
        let output = "  origin/HEAD -> origin/main\n  origin/main\n  origin/feature/x\n  origin/origin/weird\n  upstream/dev\n";
        assert_eq!(
            parse_remote_branches(output),
            vec!["main", "feature/x", "origin/weird", "upstream/dev"]
        );
    }

    // ---- reflog recency -----------------------------------------------

    #[test]
    fn reflog_checkouts_dedup_most_recent_first() {
        let output = "\
checkout: moving from main to feature/a
commit: something else
checkout: moving from feature/a to develop
checkout: moving from develop to feature/a
checkout: moving from feature/a to main
";
        assert_eq!(
            parse_reflog_checkouts(output),
            vec!["feature/a", "develop", "main"]
        );
    }

    #[test]
    fn order_branches_recent_first_then_alphabetical() {
        let recent: Vec<String> =
            ["develop", "gone-branch", "main"].iter().map(|s| s.to_string()).collect();
        let branches: Vec<String> =
            ["alpha", "develop", "main", "zeta"].iter().map(|s| s.to_string()).collect();
        let (ordered, recent_count) = order_branches_by_recency(&recent, &branches, 7);
        assert_eq!(ordered, vec!["develop", "main", "alpha", "zeta"]);
        assert_eq!(recent_count, 2);
    }

    #[test]
    fn order_branches_respects_limit() {
        let recent: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let branches = recent.clone();
        let (ordered, recent_count) = order_branches_by_recency(&recent, &branches, 2);
        assert_eq!(ordered, vec!["a", "b", "c"]); // "c" lands in the alpha tail
        assert_eq!(recent_count, 2);
    }

    // ---- status porcelain ----------------------------------------------

    #[test]
    fn status_header_with_ahead_behind() {
        let (branch, behind) =
            parse_status_branch_header("## main...origin/main [ahead 1, behind 3]");
        assert_eq!(branch, "main");
        assert_eq!(behind, 3);
    }

    #[test]
    fn status_header_without_upstream() {
        let (branch, behind) = parse_status_branch_header("## feature/local-only");
        assert_eq!(branch, "feature/local-only");
        assert_eq!(behind, 0);
    }

    #[test]
    fn porcelain_tallies_untracked_conflicts_and_double_counts() {
        // MM = partially staged → counts in BOTH staged and unstaged (§22.19).
        // R  = staged rename. UU = conflict. ?? = untracked → unstaged.
        let output = "\
## develop...origin/develop [behind 2]
MM src/app.rs
R  old_name.txt -> new_name.txt
UU conflicted.yml
?? untracked.log
 M unstaged_only.txt
A  staged_only.txt
";
        let s = parse_status_porcelain(output);
        assert_eq!(s.branch, "develop");
        assert_eq!(s.behind, 2);
        assert_eq!(s.staged, 3); // MM, R , A
        assert_eq!(s.unstaged, 3); // MM, ??,  M
        assert_eq!(s.conflicts, 1); // UU
    }

    #[test]
    fn porcelain_all_unmerged_codes_count_as_conflicts() {
        for code in ["DD", "AU", "UD", "UA", "DU", "AA", "UU"] {
            let mut s = StatusSummary::default();
            count_status_line(&format!("{code} f.txt"), &mut s);
            assert_eq!(s.conflicts, 1, "code {code}");
            assert_eq!(s.staged, 0);
            assert_eq!(s.unstaged, 0);
        }
    }

    // ---- local changes / fnmatch ----------------------------------------

    #[test]
    fn local_changes_excludes_ignored_basenames() {
        let output = "\
 M src/main/resources/application-dev.yml
 M src/lib.rs
?? .env.local
";
        let ignore = vec!["application*.yml".to_string(), ".env*".to_string()];
        assert_eq!(parse_local_changes(output, &ignore), vec!["src/lib.rs"]);
    }

    #[test]
    fn local_changes_keeps_rename_lines_raw() {
        // v1 takes line[3:] verbatim — renames keep the "old -> new" form.
        let output = "R  old.txt -> new.txt\n";
        assert_eq!(
            parse_local_changes(output, &[]),
            vec!["old.txt -> new.txt"]
        );
    }

    #[test]
    fn fnmatch_star_question_and_class() {
        assert!(fnmatch("application-dev.yml", "application*.yml"));
        assert!(fnmatch(".env.local", ".env*"));
        assert!(fnmatch("a.txt", "?.txt"));
        assert!(fnmatch("file1.log", "file[0-9].log"));
        assert!(!fnmatch("filex.log", "file[0-9].log"));
        assert!(fnmatch("filex.log", "file[!0-9].log"));
        assert!(!fnmatch("application.yaml", "application*.yml"));
        // Unterminated class is treated literally.
        assert!(fnmatch("a[b", "a[b"));
    }

    // ---- clone progress --------------------------------------------------

    #[test]
    fn clone_progress_extracts_percentage() {
        assert_eq!(
            parse_clone_progress("Receiving objects:  42% (123/290), 1.20 MiB | 2.5 MiB/s"),
            Some(42)
        );
        assert_eq!(
            parse_clone_progress("Resolving deltas: 100% (50/50), done."),
            Some(100)
        );
        assert_eq!(parse_clone_progress("Cloning into 'repo'..."), None);
        assert_eq!(parse_clone_progress("warning: something %"), None);
    }

    // ---- remote url --------------------------------------------------

    #[test]
    fn remote_url_ssh_to_https() {
        assert_eq!(
            remote_url_to_https("git@github.com:org/repo.git"),
            "https://github.com/org/repo"
        );
        // HTTPS passes through UNTOUCHED — v1 stripped `.git` only in the
        // SSH branch (git_manager.py:301-317; see normalize_remote_url).
        assert_eq!(
            remote_url_to_https("https://github.com/org/repo.git"),
            "https://github.com/org/repo.git"
        );
        assert_eq!(
            remote_url_to_https("https://github.com/org/repo"),
            "https://github.com/org/repo"
        );
    }
}

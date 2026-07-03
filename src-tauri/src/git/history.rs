//! Commit history queries — the read side of the git suite
//! (docs/superpowers/specs/2026-07-02-git-suite-design.md, phase 1).
//!
//! Everything here is a QUERY: `git log` with git-side filters, per-commit
//! file lists (`diff-tree --numstat`), one-file-at-a-time patches, and file
//! contents at a commit. Mutations stay in `ops.rs`/`branch.rs`.
//!
//! Contract points (design doc §Backend):
//! - Pagination: `LOG_PAGE_SIZE` commits per call + one look-ahead row to
//!   compute `has_more`; the cursor is a plain `--skip` offset.
//! - Filters run in git (`--author`, `--since`, `--until`, `--grep`,
//!   `-- <path>`), never in the frontend.
//! - Payload caps: any diff/file body over [`MAX_TEXT_BYTES`] is replaced by
//!   `too_large: true`; binary bodies by `binary: true`. Large blobs are
//!   size-checked with `cat-file -s` BEFORE being read.
//! - Merge commits diff against their FIRST parent (`diff-tree -m
//!   --first-parent`), which also handles root commits via `--root` — one
//!   command shape for every commit.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::exec::{is_option_like, run_git, T_FAST, T_QUERY};

/// Commits per `git_log` page (design doc: never more than 50 per IPC call).
pub const LOG_PAGE_SIZE: usize = 50;

/// Cap for diff / file-at-commit bodies crossing the IPC bridge (512 KiB).
pub const MAX_TEXT_BYTES: usize = 512 * 1024;

/// `%x1f` — field separator inside one log record.
const FIELD_SEP: char = '\x1f';
/// `%x1e` — record separator between commits.
const RECORD_SEP: char = '\x1e';

/// One commit row of the history view.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: String,
    /// Full parent SHAs, first parent first — feeds the phase-2 lane graph.
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Author date, strict ISO 8601 (`%aI`).
    pub date: String,
    pub subject: String,
    /// Ref decorations (`%D`), e.g. `HEAD -> master`, `origin/master`,
    /// `tag: v2.1.0`. Empty for undecorated commits.
    pub refs: Vec<String>,
    /// Ref the walk reached this commit from (`%S` + `--source`) — names
    /// EVERY commit's branch, including filtered views where decorations
    /// and lane inheritance can't (graph lane labels, phase 3).
    pub source: String,
}

/// One `git_log` page.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub commits: Vec<CommitInfo>,
    /// More history exists past this page (ask again with a higher `skip`).
    pub has_more: bool,
}

/// `git_log` filters — all optional, all applied by git itself.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LogFilter {
    /// Walk ALL refs (`--all`) — the whole-repo flow view. Ignored when
    /// `branch` is set (phase 2: contextual scope, design decisions).
    pub all: bool,
    /// Rev to walk from (branch, tag, sha). `None` ⇒ `HEAD`.
    pub branch: Option<String>,
    /// Case-insensitive author name/email substring (`-i --author`).
    pub author: Option<String>,
    /// `--since` (git-parsed date expression).
    pub since: Option<String>,
    /// `--until`.
    pub until: Option<String>,
    /// Case-insensitive commit-message substring (`-i --grep`).
    pub grep: Option<String>,
    /// Limit history to one path (file or directory).
    pub path: Option<String>,
    /// Pagination cursor: rows already consumed.
    pub skip: u32,
}

/// One file touched by a commit (`diff-tree --numstat -M` row).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileStat {
    /// Path after the commit (rename target for renames).
    pub path: String,
    /// Pre-rename path when the row is a rename, else `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub additions: u32,
    pub deletions: u32,
    /// Numstat printed `-\t-` — binary blob, no line counts.
    pub binary: bool,
}

/// Body of `git_commit_file_diff` / `git_working_diff`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// Unified diff text; `None` when `binary` or `too_large`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    pub binary: bool,
    pub too_large: bool,
}

/// Body of `git_file_at_commit`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileAtCommit {
    /// Full file text; `None` when `binary` or `too_large`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    pub binary: bool,
    pub too_large: bool,
    /// Blob size in bytes (from `cat-file -s`), also when too large.
    pub size: u64,
}

/// One repo author (`git shortlog -sne --all` row) — feeds the author
/// filter dropdown (phase 2).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorInfo {
    pub name: String,
    pub email: String,
    pub commits: u32,
}

/// All authors of the repo, most commits first. Same ref set as [`get_log`]
/// (no `--all` — stash refs would count the local user as an author).
pub async fn get_authors(repo: &Path) -> Result<Vec<AuthorInfo>, String> {
    let args = ["shortlog", "-sne", "--branches", "--remotes", "--tags", "HEAD"];
    let out = run_git(repo, &args, T_QUERY)
        .await
        .map_err(|e| e.to_string())?;
    if !out.success {
        return Err(out.error_message());
    }
    Ok(parse_shortlog(&out.stdout))
}

/// Cap for the path-autocomplete file list (`git_ls_files`).
pub const LS_FILES_CAP: usize = 5000;

/// Tracked files of the repo (`git ls-files`), capped — feeds the history
/// path filter's autocomplete (phase 3 follow-up).
pub async fn list_files(repo: &Path) -> Result<Vec<String>, String> {
    let out = run_git(repo, &["ls-files"], T_QUERY).await.map_err(|e| e.to_string())?;
    if !out.success {
        return Err(out.error_message());
    }
    Ok(out
        .stdout
        .lines()
        .filter(|l| !l.is_empty())
        .take(LS_FILES_CAP)
        .map(str::to_string)
        .collect())
}

/// Full commit message (`%B`, subject + body) — the log format carries only
/// the subject; the detail view fetches the rest on demand.
pub async fn get_commit_body(repo: &Path, sha: &str) -> Result<String, String> {
    if is_option_like(sha) {
        return Err(format!("invalid revision: {sha}"));
    }
    let out = run_git(repo, &["show", "-s", "--format=%B", sha], T_QUERY)
        .await
        .map_err(|e| e.to_string())?;
    if !out.success {
        return Err(out.error_message());
    }
    Ok(out.stdout.trim().to_string())
}

/// `rev` resolves to a commit in this repo (`rev-parse --verify --quiet`).
async fn rev_verifies(repo: &Path, rev: &str) -> bool {
    let spec = format!("{rev}^{{commit}}");
    matches!(
        run_git(repo, &["rev-parse", "--verify", "--quiet", &spec], T_FAST).await,
        Ok(out) if out.success
    )
}

/// Resolve a user-picked rev to something git can walk. The branch dropdown
/// lists remote-only branches WITHOUT their `origin/` prefix (v1 checkout
/// convenience, `parse_remote_branches`), so a rev that doesn't verify
/// locally retries as `origin/<rev>` — the same tracking fallback checkout
/// applies. Unresolvable revs pass through so git reports its own error.
async fn resolve_rev(repo: &Path, rev: &str) -> String {
    if rev_verifies(repo, rev).await {
        return rev.to_string();
    }
    let remote = format!("origin/{rev}");
    if rev_verifies(repo, &remote).await {
        return remote;
    }
    rev.to_string()
}

/// [`resolve_rev`] applied to each side of an optional `..`/`...` range —
/// the compare view's commit list passes `base..target` as the log rev.
async fn resolve_rev_or_range(repo: &Path, rev: &str) -> String {
    for op in ["...", ".."] {
        if let Some((a, b)) = rev.split_once(op) {
            if !a.is_empty() && !b.is_empty() {
                return format!("{}{op}{}", resolve_rev(repo, a).await, resolve_rev(repo, b).await);
            }
        }
    }
    resolve_rev(repo, rev).await
}

/// Paginated, filtered `git log`. Errors surface as the git message so the
/// UI can show "unknown revision" verbatim.
pub async fn get_log(repo: &Path, filter: &LogFilter) -> Result<LogPage, String> {
    // Positional rev — the one place a user string could be promoted to a
    // flag; `--author=…` etc. are single attached args and safe by shape.
    let mut resolved_branch: Option<String> = None;
    if let Some(rev) = filter.branch.as_deref() {
        if is_option_like(rev) {
            return Err(format!("invalid revision: {rev}"));
        }
        resolved_branch = Some(resolve_rev_or_range(repo, rev).await);
    }

    let look_ahead = (LOG_PAGE_SIZE + 1).to_string();
    let skip = format!("--skip={}", filter.skip);
    let format = format!("--format=%H{FIELD_SEP}%P{FIELD_SEP}%an{FIELD_SEP}%ae{FIELD_SEP}%aI{FIELD_SEP}%D{FIELD_SEP}%S{FIELD_SEP}%s{RECORD_SEP}");

    // --topo-order keeps parents below children and parallel branches
    // contiguous — the lane graph (phase 2) depends on it. --source feeds
    // %S (per-commit reaching ref).
    let mut args: Vec<&str> =
        vec!["log", "--topo-order", "--source", &format, "-n", &look_ahead, &skip];
    if filter.all && filter.branch.is_none() {
        // NOT --all: that walks refs/stash too, so the stash machinery
        // commits ("WIP on …", authored by the LOCAL user) show up as
        // regular history (user report 2026-07-02, spring-petclinic).
        args.extend(["--branches", "--remotes", "--tags"]);
    }
    let author = filter.author.as_ref().map(|a| format!("--author={a}"));
    let since = filter.since.as_ref().map(|s| format!("--since={s}"));
    let until = filter.until.as_ref().map(|u| format!("--until={u}"));
    let grep = filter.grep.as_ref().map(|g| format!("--grep={g}"));
    for opt in [&author, &grep] {
        if opt.is_some() {
            args.push("--regexp-ignore-case");
            break;
        }
    }
    for opt in [&author, &since, &until, &grep] {
        if let Some(o) = opt {
            args.push(o);
        }
    }
    if let Some(rev) = resolved_branch.as_deref() {
        args.push(rev);
    }
    if let Some(path) = filter.path.as_deref() {
        args.push("--");
        args.push(path);
    }

    let out = run_git(repo, &args, T_QUERY).await.map_err(|e| e.to_string())?;
    if !out.success {
        return Err(out.error_message());
    }

    let mut commits = parse_log(&out.stdout);
    let has_more = commits.len() > LOG_PAGE_SIZE;
    commits.truncate(LOG_PAGE_SIZE);
    Ok(LogPage { commits, has_more })
}

/// Files touched by one commit, with add/del counts — the diff against the
/// FIRST parent (`<sha>^1 <sha>`). NEVER `diff-tree -m`: on multi-parent
/// commits (merges, and stash commits with their index/untracked parents)
/// `-m` emits one CONCATENATED section per parent, duplicating every path
/// (user report 2026-07-03: a stash file listed 3×). Root commits have no
/// `^1` — fall back to `diff-tree --root` (single section, verified).
pub async fn get_commit_files(repo: &Path, sha: &str) -> Result<Vec<CommitFileStat>, String> {
    if is_option_like(sha) {
        return Err(format!("invalid revision: {sha}"));
    }
    let first_parent = format!("{sha}^1");
    let args = ["diff", "--numstat", "-M", &first_parent, sha];
    let out = run_git(repo, &args, T_QUERY).await.map_err(|e| e.to_string())?;
    if out.success {
        return Ok(parse_numstat(&out.stdout));
    }
    let root_args = ["diff-tree", "-r", "--root", "--numstat", "-M", sha];
    let out = run_git(repo, &root_args, T_QUERY).await.map_err(|e| e.to_string())?;
    if !out.success {
        return Err(out.error_message());
    }
    Ok(parse_numstat(&out.stdout))
}

/// Unified diff of ONE file in one commit (against the first parent). Same
/// no-`-m` rationale and root fallback as [`get_commit_files`].
pub async fn get_commit_file_diff(repo: &Path, sha: &str, path: &str) -> Result<FileDiff, String> {
    if is_option_like(sha) {
        return Err(format!("invalid revision: {sha}"));
    }
    let first_parent = format!("{sha}^1");
    let args = ["diff", "-M", &first_parent, sha, "--", path];
    let out = run_git(repo, &args, T_QUERY).await.map_err(|e| e.to_string())?;
    if out.success {
        return Ok(fold_diff_body(&out.stdout));
    }
    let root_args = ["diff-tree", "-r", "--root", "-p", "-M", sha, "--", path];
    let out = run_git(repo, &root_args, T_QUERY).await.map_err(|e| e.to_string())?;
    if !out.success {
        return Err(out.error_message());
    }
    Ok(fold_diff_body(strip_diff_tree_header(&out.stdout)))
}

/// Files changed between two revs (`git diff --numstat base...target` —
/// triple dot: what `target` adds since the merge base, the compare /
/// incoming-changes semantics). Phase 3 compare view.
pub async fn get_range_files(
    repo: &Path,
    base: &str,
    target: &str,
) -> Result<Vec<CommitFileStat>, String> {
    range_arg(base, target)?; // validate BEFORE resolving (guards option-like)
    let (base, target) = (resolve_rev(repo, base).await, resolve_rev(repo, target).await);
    let range = range_arg(&base, &target)?;
    let out = run_git(repo, &["diff", "--numstat", "-M", &range], T_QUERY)
        .await
        .map_err(|e| e.to_string())?;
    if !out.success {
        return Err(out.error_message());
    }
    Ok(parse_numstat(&out.stdout))
}

/// Unified diff of ONE file between two revs (compare view).
pub async fn get_range_file_diff(
    repo: &Path,
    base: &str,
    target: &str,
    path: &str,
) -> Result<FileDiff, String> {
    range_arg(base, target)?; // validate BEFORE resolving (guards option-like)
    let (base, target) = (resolve_rev(repo, base).await, resolve_rev(repo, target).await);
    let range = range_arg(&base, &target)?;
    let out = run_git(repo, &["diff", "-M", &range, "--", path], T_QUERY)
        .await
        .map_err(|e| e.to_string())?;
    if !out.success {
        return Err(out.error_message());
    }
    Ok(fold_diff_body(&out.stdout))
}

/// Compose the guarded `base...target` range argument.
fn range_arg(base: &str, target: &str) -> Result<String, String> {
    for rev in [base, target] {
        if rev.is_empty() || is_option_like(rev) || rev.contains("..") {
            return Err(format!("invalid revision: {rev}"));
        }
    }
    Ok(format!("{base}...{target}"))
}

/// Working-tree diff of ONE file (`staged` selects `--cached`) — the stage
/// view's diff source (design doc §Frontend/stage).
pub async fn get_working_diff(repo: &Path, path: &str, staged: bool) -> Result<FileDiff, String> {
    let mut args: Vec<&str> = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(path);
    let out = run_git(repo, &args, T_QUERY).await.map_err(|e| e.to_string())?;
    if !out.success {
        return Err(out.error_message());
    }
    Ok(fold_diff_body(&out.stdout))
}

/// Full file contents at a commit (`git show <sha>:<path>`), size-guarded
/// with `cat-file -s` so oversized blobs are never read into memory.
pub async fn get_file_at_commit(repo: &Path, sha: &str, path: &str) -> Result<FileAtCommit, String> {
    if is_option_like(sha) {
        return Err(format!("invalid revision: {sha}"));
    }
    let spec = format!("{sha}:{path}");

    let size_out = run_git(repo, &["cat-file", "-s", &spec], T_QUERY)
        .await
        .map_err(|e| e.to_string())?;
    if !size_out.success {
        return Err(size_out.error_message());
    }
    let size: u64 = size_out.stdout.trim().parse().unwrap_or(0);
    if size as usize > MAX_TEXT_BYTES {
        return Ok(FileAtCommit { content: None, binary: false, too_large: true, size });
    }

    let out = run_git(repo, &["show", &spec], T_QUERY).await.map_err(|e| e.to_string())?;
    if !out.success {
        return Err(out.error_message());
    }
    if out.stdout.contains('\0') {
        return Ok(FileAtCommit { content: None, binary: true, too_large: false, size });
    }
    Ok(FileAtCommit { content: Some(out.stdout), binary: false, too_large: false, size })
}

// ---------------------------------------------------------------------------
// pure parsers (unit-tested below)
// ---------------------------------------------------------------------------

/// Parse `%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1e`-formatted records.
/// The subject is the LAST field on purpose: a subject containing `\x1f`
/// cannot shift the fields before it.
fn parse_log(stdout: &str) -> Vec<CommitInfo> {
    stdout
        .split(RECORD_SEP)
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .filter_map(|record| {
            let mut f = record.splitn(8, FIELD_SEP);
            let sha = f.next()?.trim().to_string();
            if sha.is_empty() {
                return None;
            }
            let parents = f
                .next()?
                .split_whitespace()
                .map(str::to_string)
                .collect();
            let author_name = f.next()?.to_string();
            let author_email = f.next()?.to_string();
            let date = f.next()?.to_string();
            let refs = f
                .next()?
                .split(", ")
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect();
            let source = f.next()?.trim().to_string();
            let subject = f.next().unwrap_or("").to_string();
            Some(CommitInfo {
                sha, parents, author_name, author_email, date, subject, refs, source,
            })
        })
        .collect()
}

/// Parse `--numstat` rows (`adds\tdels\tpath`). Non-numstat lines (the
/// leading `diff-tree` sha header) have no tabs and fall through. `-\t-`
/// marks a binary blob; rename paths use `old => new`, optionally with the
/// common-prefix brace form `dir/{old => new}/file`.
fn parse_numstat(stdout: &str) -> Vec<CommitFileStat> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut cols = line.splitn(3, '\t');
            let adds = cols.next()?;
            let dels = cols.next()?;
            let raw_path = cols.next()?;
            let binary = adds == "-";
            let (old_path, path) = split_rename(raw_path);
            Some(CommitFileStat {
                path,
                old_path,
                additions: adds.parse().unwrap_or(0),
                deletions: dels.parse().unwrap_or(0),
                binary,
            })
        })
        .collect()
}

/// Resolve numstat rename notation into `(old, new)` paths.
/// `src/{a => b}/f.rs` → (`src/a/f.rs`, `src/b/f.rs`); `old.rs => new.rs` →
/// (`old.rs`, `new.rs`); plain paths → (`None`, path).
fn split_rename(raw: &str) -> (Option<String>, String) {
    if let (Some(open), Some(close)) = (raw.find('{'), raw.find('}')) {
        if open < close {
            if let Some((from, to)) = raw[open + 1..close].split_once(" => ") {
                let prefix = &raw[..open];
                let suffix = &raw[close + 1..];
                let old = normalize_rename_path(&format!("{prefix}{from}{suffix}"));
                let new = normalize_rename_path(&format!("{prefix}{to}{suffix}"));
                return (Some(old), new);
            }
        }
    }
    if let Some((from, to)) = raw.split_once(" => ") {
        return (Some(from.to_string()), to.to_string());
    }
    (None, raw.to_string())
}

/// An empty brace side leaves a doubled slash (`src/{ => b}/f` → `src//f`).
fn normalize_rename_path(path: &str) -> String {
    path.replace("//", "/")
}

/// Parse `git shortlog -sne` rows: `<spaces><count>\t<name> <<email>>`.
/// Rows that don't match the shape (defensive) are skipped.
fn parse_shortlog(stdout: &str) -> Vec<AuthorInfo> {
    stdout
        .lines()
        .filter_map(|line| {
            let (count, rest) = line.trim_start().split_once('\t')?;
            let rest = rest.trim();
            let open = rest.rfind('<')?;
            let email = rest[open + 1..].strip_suffix('>')?.to_string();
            let name = rest[..open].trim().to_string();
            Some(AuthorInfo { name, email, commits: count.trim().parse().unwrap_or(0) })
        })
        .collect()
}

/// Drop `diff-tree`'s leading commit-sha header line (everything before the
/// first `diff --git`); an empty diff (file untouched) yields "".
fn strip_diff_tree_header(stdout: &str) -> &str {
    match stdout.find("diff --git") {
        Some(idx) => &stdout[idx..],
        None => "",
    }
}

/// Apply the binary / size-cap folds shared by every diff-shaped payload.
fn fold_diff_body(body: &str) -> FileDiff {
    if body.len() > MAX_TEXT_BYTES {
        return FileDiff { content: None, binary: false, too_large: true };
    }
    // `git diff` announces binary content instead of emitting a text patch.
    if body.starts_with("Binary files ") || body.contains("\nBinary files ") {
        return FileDiff { content: None, binary: true, too_large: false };
    }
    FileDiff { content: Some(body.to_string()), binary: false, too_large: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(fields: &[&str]) -> String {
        format!("{}{RECORD_SEP}\n", fields.join(&FIELD_SEP.to_string()))
    }

    #[test]
    fn parses_full_log_record() {
        let raw = record(&[
            "abc123",
            "p1 p2",
            "Jordi Tomás",
            "jordi@example.com",
            "2026-07-02T10:00:00+02:00",
            "HEAD -> master, origin/master, tag: v2.1.0",
            "master",
            "feat: subject",
        ]);
        let commits = parse_log(&raw);
        assert_eq!(commits.len(), 1);
        let c = &commits[0];
        assert_eq!(c.sha, "abc123");
        assert_eq!(c.parents, vec!["p1", "p2"]);
        assert_eq!(c.author_name, "Jordi Tomás");
        assert_eq!(c.author_email, "jordi@example.com");
        assert_eq!(c.date, "2026-07-02T10:00:00+02:00");
        assert_eq!(c.refs, vec!["HEAD -> master", "origin/master", "tag: v2.1.0"]);
        assert_eq!(c.source, "master");
        assert_eq!(c.subject, "feat: subject");
    }

    #[test]
    fn parses_root_commit_and_empty_decorations() {
        let raw = record(&["abc", "", "A", "a@x", "2026-01-01T00:00:00Z", "", "", "root"]);
        let commits = parse_log(&raw);
        assert_eq!(commits[0].parents, Vec::<String>::new());
        assert_eq!(commits[0].refs, Vec::<String>::new());
    }

    #[test]
    fn parses_multiple_records_and_skips_blank_tail() {
        let raw = format!(
            "{}{}",
            record(&["a1", "", "A", "a@x", "d", "", "", "one"]),
            record(&["b2", "a1", "B", "b@x", "d", "", "", "two"])
        );
        let commits = parse_log(&raw);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[1].sha, "b2");
        assert_eq!(commits[1].parents, vec!["a1"]);
    }

    #[test]
    fn subject_keeps_stray_field_separators() {
        // Subject is the last splitn field — embedded \x1f must not shift refs.
        let raw = record(&["a", "", "A", "a@x", "d", "", "", "subject\x1fwith sep"]);
        assert_eq!(parse_log(&raw)[0].subject, "subject\x1fwith sep");
    }

    #[test]
    fn numstat_skips_diff_tree_header_line() {
        let raw = "278120eb7ab7de76ba34eaca7ee2a0fb3ceacdea\n17\t4\tbot/commands.py\n";
        let stats = parse_numstat(raw);
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].path, "bot/commands.py");
        assert_eq!((stats[0].additions, stats[0].deletions), (17, 4));
        assert!(!stats[0].binary);
    }

    #[test]
    fn numstat_marks_binary_rows() {
        let stats = parse_numstat("-\t-\tassets/logo.png\n");
        assert!(stats[0].binary);
        assert_eq!((stats[0].additions, stats[0].deletions), (0, 0));
    }

    #[test]
    fn numstat_resolves_brace_renames() {
        let stats = parse_numstat("1\t1\tsrc/{app => core}/main.rs\n");
        assert_eq!(stats[0].path, "src/core/main.rs");
        assert_eq!(stats[0].old_path.as_deref(), Some("src/app/main.rs"));
    }

    #[test]
    fn numstat_resolves_plain_renames_and_empty_brace_side() {
        let stats = parse_numstat("0\t0\told.txt => new.txt\n2\t0\tsrc/{ => sub}/f.rs\n");
        assert_eq!(stats[0].path, "new.txt");
        assert_eq!(stats[0].old_path.as_deref(), Some("old.txt"));
        assert_eq!(stats[1].path, "src/sub/f.rs");
        assert_eq!(stats[1].old_path.as_deref(), Some("src/f.rs"));
    }

    #[test]
    fn range_arg_guards_option_like_and_nested_ranges() {
        assert_eq!(range_arg("main", "origin/main").unwrap(), "main...origin/main");
        assert!(range_arg("-x", "main").is_err());
        assert!(range_arg("main", "").is_err());
        assert!(range_arg("a..b", "main").is_err());
    }

    #[test]
    fn parses_shortlog_rows() {
        let raw = "   130\tJordi <jorditomasg@gmail.com>\n     1\tJordi Tomás <jordi00010@gmail.com>\n";
        let authors = parse_shortlog(raw);
        assert_eq!(authors.len(), 2);
        assert_eq!(authors[0].name, "Jordi");
        assert_eq!(authors[0].email, "jorditomasg@gmail.com");
        assert_eq!(authors[0].commits, 130);
        assert_eq!(authors[1].name, "Jordi Tomás");
    }

    #[test]
    fn shortlog_skips_malformed_rows_and_keeps_angled_names() {
        // A name containing '<' still resolves via the LAST '<'.
        let raw = "  2\tWeird <name <weird@x.com>\ngarbage line\n";
        let authors = parse_shortlog(raw);
        assert_eq!(authors.len(), 1);
        assert_eq!(authors[0].name, "Weird <name");
        assert_eq!(authors[0].email, "weird@x.com");
    }

    #[test]
    fn strips_diff_tree_sha_header() {
        let raw = "abc123\ndiff --git a/f b/f\n+x\n";
        assert_eq!(strip_diff_tree_header(raw), "diff --git a/f b/f\n+x\n");
        assert_eq!(strip_diff_tree_header("abc123\n"), "");
    }

    #[test]
    fn folds_binary_and_oversized_diffs() {
        assert!(fold_diff_body("Binary files a/x and b/x differ\n").binary);
        let big = "x".repeat(MAX_TEXT_BYTES + 1);
        assert!(fold_diff_body(&big).too_large);
        let ok = fold_diff_body("diff --git a/f b/f\n");
        assert_eq!(ok.content.as_deref(), Some("diff --git a/f b/f\n"));
    }
}

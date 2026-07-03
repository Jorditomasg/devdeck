//! Working-tree surface — the git changes window
//! (docs/superpowers/specs/2026-07-03-git-changes-window-design.md; the
//! git-suite phase-3 "stage view" reshaped).
//!
//! Queries: per-file `git status --porcelain -z` (pure parser below) and
//! working-file reads. Safe actions: stage / unstage / discard, all via
//! [`super::exec`] (WSL routing, no shell, `--` before every path).
//!
//! `read_working_file` / `write_working_file` are the ONLY places DevDeck
//! touches repo files directly. Both go through [`resolve_in_repo`], the
//! trust boundary: relative paths only, no `..`, canonicalized result must
//! stay under the canonicalized repo root (symlink escapes fail the prefix
//! check). Write never creates files — it only saves edits to files git
//! already reports as changed.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::exec::{is_option_like, repo_name, run_git, run_logged_op, T_BRANCH_OP, T_QUERY};
use super::history::{FileAtCommit, MAX_TEXT_BYTES};
use super::types::{emit, LogSink, OpOutput};

/// One row of the changes window. A partially staged file (porcelain `MM`)
/// yields TWO entries: one staged, one unstaged — mirroring the v1 badge's
/// double-count rule (§22.19) and VS Code's two-group model.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEntry {
    /// Path relative to the repo root (rename target for renames).
    pub path: String,
    /// Pre-rename path when the row is a staged rename, else `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// `true` = staged group (index vs HEAD), `false` = changes group.
    pub staged: bool,
    /// Status letter for the row: `M`/`A`/`D`/`R`/`T`… from porcelain XY,
    /// with `??` folded to `U` (untracked) and conflict states to `C`.
    pub status: String,
}

/// Working-tree changes, both groups (`git status --porcelain -z`).
pub async fn get_changes(repo: &Path) -> Result<Vec<ChangeEntry>, String> {
    let args = ["--no-optional-locks", "status", "--porcelain", "-z"];
    let out = run_git(repo, &args, T_QUERY).await.map_err(|e| e.to_string())?;
    if !out.success {
        return Err(out.error_message());
    }
    Ok(parse_changes(&out.stdout))
}

/// `git add -- <path>` — stage one file (on a conflicted file this marks it
/// resolved, plain git semantics).
pub async fn stage_file(repo: &Path, path: &str, log: Option<&LogSink>) -> OpOutput {
    path_op(repo, &["add", "--"], path, log).await
}

/// `git restore --staged -- <path>` — unstage one file.
pub async fn unstage_file(repo: &Path, path: &str, log: Option<&LogSink>) -> OpOutput {
    path_op(repo, &["restore", "--staged", "--"], path, log).await
}

/// Discard the working-tree changes of one file. Tracked files restore from
/// the index (`git restore --`); untracked files are removed via
/// `git clean -f --` (git-side on purpose: WSL routing + ignore semantics,
/// never a raw `fs::remove_file`). DESTRUCTIVE — the frontend confirms first.
pub async fn discard_file(
    repo: &Path,
    path: &str,
    untracked: bool,
    log: Option<&LogSink>,
) -> OpOutput {
    let prefix: &[&str] = if untracked { &["clean", "-f", "--"] } else { &["restore", "--"] };
    path_op(repo, prefix, path, log).await
}

/// Shared shape of the per-file ops: validate, log, run with `--` separator.
async fn path_op(repo: &Path, prefix: &[&str], path: &str, log: Option<&LogSink>) -> OpOutput {
    if let Err(message) = validate_rel_path(path) {
        return OpOutput { ok: false, message };
    }
    let mut args: Vec<&str> = prefix.to_vec();
    args.push(path);
    emit(log, &format!("[git] {}: git {}", repo_name(repo), args.join(" ")));
    run_logged_op(repo, &args, T_BRANCH_OP, log).await
}

/// Working-tree file contents — same payload/caps as `git_file_at_commit`
/// (512 KiB ⇒ `too_large`, NUL byte ⇒ `binary`).
pub async fn read_working_file(repo: &Path, path: &str) -> Result<FileAtCommit, String> {
    let full = resolve_in_repo(repo, path)?;
    let size = std::fs::metadata(&full).map_err(|e| format!("read {path}: {e}"))?.len();
    if size as usize > MAX_TEXT_BYTES {
        return Ok(FileAtCommit { content: None, binary: false, too_large: true, size });
    }
    let bytes = std::fs::read(&full).map_err(|e| format!("read {path}: {e}"))?;
    if bytes.contains(&0) {
        return Ok(FileAtCommit { content: None, binary: true, too_large: false, size });
    }
    Ok(FileAtCommit {
        content: Some(String::from_utf8_lossy(&bytes).into_owned()),
        binary: false,
        too_large: false,
        size,
    })
}

/// Save an edited working-tree file. The file must already exist (the guard
/// canonicalizes it) — this never creates paths.
pub async fn write_working_file(repo: &Path, path: &str, content: &str) -> Result<(), String> {
    let full = resolve_in_repo(repo, path)?;
    std::fs::write(&full, content).map_err(|e| format!("write {path}: {e}"))
}

/// Trust boundary for direct file access: `rel` must be a plain relative
/// path (no `..`, not option-like, not absolute) and, once canonicalized
/// (which requires it to EXIST and resolves symlinks), must still live under
/// the canonicalized repo root.
fn resolve_in_repo(repo: &Path, rel: &str) -> Result<PathBuf, String> {
    validate_rel_path(rel)?;
    let root = repo
        .canonicalize()
        .map_err(|e| format!("resolve repo root: {e}"))?;
    let full = root
        .join(rel)
        .canonicalize()
        .map_err(|e| format!("resolve {rel}: {e}"))?;
    if !full.starts_with(&root) {
        return Err(format!("path escapes the repository: {rel}"));
    }
    Ok(full)
}

/// Cheap syntactic checks shared by the guard and the git path ops.
fn validate_rel_path(rel: &str) -> Result<(), String> {
    if rel.is_empty() || is_option_like(rel) {
        return Err(format!("invalid path: {rel}"));
    }
    let path = Path::new(rel);
    if path.is_absolute() || rel.starts_with('/') || rel.starts_with('\\') {
        return Err(format!("absolute paths not allowed: {rel}"));
    }
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(format!("path escapes the repository: {rel}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// pure parser (unit-tested below)
// ---------------------------------------------------------------------------

/// Conflict XY pairs (`git status` porcelain v1, "unmerged" table).
const CONFLICT_CODES: [&str; 7] = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];

/// Parse `git status --porcelain -z` output. `-z` entries are NUL-separated;
/// a staged rename/copy (`R`/`C` in X) is followed by ONE extra NUL-separated
/// token: the ORIGINAL path.
fn parse_changes(stdout: &str) -> Vec<ChangeEntry> {
    let mut entries = Vec::new();
    let mut tokens = stdout.split('\0');
    while let Some(token) = tokens.next() {
        if token.len() < 4 || !token.is_char_boundary(2) || !token.is_char_boundary(3) {
            continue; // trailing empty token / malformed row
        }
        let (xy, path) = token.split_at(2);
        let path = &path[1..]; // skip the separating space
        if path.is_empty() {
            continue;
        }
        let (x, y) = (&xy[..1], &xy[1..]);
        let old_path = if x == "R" || x == "C" {
            tokens.next().filter(|s| !s.is_empty()).map(str::to_string)
        } else {
            None
        };

        if xy == "??" {
            entries.push(ChangeEntry {
                path: path.to_string(),
                old_path: None,
                staged: false,
                status: "U".into(),
            });
            continue;
        }
        if CONFLICT_CODES.contains(&xy) {
            entries.push(ChangeEntry {
                path: path.to_string(),
                old_path: None,
                staged: false,
                status: "C".into(),
            });
            continue;
        }
        if x != " " {
            entries.push(ChangeEntry {
                path: path.to_string(),
                old_path,
                staged: true,
                status: x.into(),
            });
        }
        if y != " " {
            entries.push(ChangeEntry {
                path: path.to_string(),
                old_path: None,
                staged: false,
                status: y.into(),
            });
        }
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, staged: bool, status: &str) -> ChangeEntry {
        ChangeEntry { path: path.into(), old_path: None, staged, status: status.into() }
    }

    #[test]
    fn parses_the_porcelain_zoo() {
        // M_ staged, _M unstaged, MM both, ?? untracked, UU conflict,
        // R staged rename (extra NUL token = old path), D_ staged delete.
        let raw = "M  staged.txt\0 M unstaged.txt\0MM both.txt\0?? new.txt\0\
UU conflicted.txt\0R  renamed.txt\0old-name.txt\0D  deleted.txt\0";
        let parsed = parse_changes(raw);
        assert_eq!(
            parsed,
            vec![
                entry("staged.txt", true, "M"),
                entry("unstaged.txt", false, "M"),
                entry("both.txt", true, "M"),
                entry("both.txt", false, "M"),
                entry("new.txt", false, "U"),
                entry("conflicted.txt", false, "C"),
                ChangeEntry {
                    path: "renamed.txt".into(),
                    old_path: Some("old-name.txt".into()),
                    staged: true,
                    status: "R".into(),
                },
                entry("deleted.txt", true, "D"),
            ]
        );
    }

    #[test]
    fn parses_rename_with_worktree_edit() {
        // RM: staged rename + further unstaged edit of the NEW path.
        let raw = "RM renamed.txt\0old.txt\0";
        let parsed = parse_changes(raw);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].old_path.as_deref(), Some("old.txt"));
        assert!(parsed[0].staged);
        assert_eq!(parsed[1], entry("renamed.txt", false, "M"));
    }

    #[test]
    fn tolerates_empty_and_garbage_tokens() {
        assert!(parse_changes("").is_empty());
        assert!(parse_changes("\0\0x\0").is_empty());
    }

    #[test]
    fn rejects_escaping_paths() {
        assert!(validate_rel_path("../outside.txt").is_err());
        assert!(validate_rel_path("a/../../outside.txt").is_err());
        assert!(validate_rel_path("/etc/passwd").is_err());
        assert!(validate_rel_path("\\evil").is_err());
        assert!(validate_rel_path("--upload-pack=x").is_err());
        assert!(validate_rel_path("").is_err());
        assert!(validate_rel_path("src/ok.rs").is_ok());
        assert!(validate_rel_path("with spaces/ok.txt").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_absolute_paths() {
        assert!(validate_rel_path("C:\\Windows\\system32\\evil").is_err());
        assert!(validate_rel_path("C:/x").is_err());
    }

    #[test]
    fn resolve_in_repo_guards_the_root() {
        // Real directories: canonicalize needs existing paths.
        let base = std::env::temp_dir().join(format!("devdeck-worktree-{}", std::process::id()));
        let repo = base.join("repo");
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        std::fs::write(repo.join("sub/file.txt"), "x").unwrap();
        std::fs::write(base.join("outside.txt"), "x").unwrap();

        assert!(resolve_in_repo(&repo, "sub/file.txt").is_ok());
        assert!(resolve_in_repo(&repo, "sub/../../outside.txt").is_err());
        assert!(resolve_in_repo(&repo, "missing.txt").is_err()); // must exist

        #[cfg(unix)]
        {
            // A symlink INSIDE the repo pointing OUTSIDE must be rejected by
            // the post-canonicalize prefix check.
            let link = repo.join("escape.txt");
            let _ = std::fs::remove_file(&link);
            std::os::unix::fs::symlink(base.join("outside.txt"), &link).unwrap();
            assert!(resolve_in_repo(&repo, "escape.txt").is_err());
        }

        let _ = std::fs::remove_dir_all(&base);
    }
}

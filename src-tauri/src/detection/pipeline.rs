//! Matching pipeline and workspace scanning.
//!
//! Port of `_matches_definition` / `_classify_repo` / `detect_repos` /
//! `detect_repos_for_group` (project_analyzer.py:35-169,
//! inventory-backend.md §6.2-§6.5, inventory-config-ci.md §1.3), with the v1
//! hardcoded type-name special cases expressed as schema flags
//! (`detection.allow_no_git`, `heuristics.pattern_search_dirs` — they ship in
//! the bundled YAMLs, architecture-v2.md §5) and `must_match_package_json`
//! actually enforced (§7 fix 3).
//!
//! Gate order is the exact v1 order; ALL must pass, first matching
//! definition (in priority-descending order) wins:
//! 1. git gate, 2. required_files, 3. exclude_files, 4. directory
//! heuristics, 5. pattern heuristics, 6. package.json heuristics (v2, slots
//! after the v1 gates — a pure ADDITIVE restriction).

use crate::detection::builder::build_repo_info;
use crate::detection::glob::fnmatch;
use crate::domain::{RepoInfo, RepoTypeDef};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Semaphore;

/// Classification concurrency cap — v1 used
/// `ThreadPoolExecutor(max_workers=min(8, n))` (project_analyzer.py:58).
pub const MAX_CLASSIFY_CONCURRENCY: usize = 8;

/// Per-repo scan progress callback: `(detected, total)` — repos detected so
/// far / candidate directories in the current root. The commands layer maps
/// it onto `repo://scan-progress` (`phase: "classifying"`) so the status bar
/// advances while classification runs (ipc-contract.md §2.2 / §3).
pub type ScanProgressFn = dyn Fn(u32, u32) + Send + Sync;

/// Check one definition against a candidate directory, v1 gate order.
/// `files_in_root` = plain-file basenames directly in the repo root
/// (computed once per candidate, project_analyzer.py:84-87).
pub fn matches_definition(
    repo_root: &Path,
    files_in_root: &HashSet<String>,
    def: &RepoTypeDef,
) -> bool {
    // 1. Git gate — `.git` DIRECTORY required unless `detect.git_required: false`
    //    (v1 hardcoded the docker-infra exemption, §1.3 step 1).
    if def.detect.git_required && !repo_root.join(".git").is_dir() {
        return false;
    }
    // 2. required files: every name exists as a plain file in the root.
    if !def
        .detect
        .files
        .required
        .iter()
        .all(|f| files_in_root.contains(f))
    {
        return false;
    }
    // 3. excluded files: none may exist.
    if def
        .detect
        .files
        .excluded
        .iter()
        .any(|f| files_in_root.contains(f))
    {
        return false;
    }
    // 4. Directory rules (nested paths allowed).
    if !def
        .detect
        .dirs
        .required
        .iter()
        .all(|d| repo_root.join(d).is_dir())
    {
        return false;
    }
    if def
        .detect
        .dirs
        .excluded
        .iter()
        .any(|d| repo_root.join(d).is_dir())
    {
        return false;
    }
    // 5. Pattern heuristics (with search_dirs fallback).
    if !check_pattern_heuristics(repo_root, files_in_root, &def.detect.patterns) {
        return false;
    }
    // 6. package.json gate (v2 — formerly dead key, §22.5 backend).
    if !check_package_json(repo_root, &def.detect.package_json) {
        return false;
    }
    true
}

/// `must_match_patterns`: at least one root file matches at least one glob;
/// when nothing matched at root, plain files in each `pattern_search_dirs`
/// directory are also tried (v2 generalization of the v1 hardcoded
/// spring-boot `src/main/resources` fallback, project_analyzer.py:141-156).
fn check_pattern_heuristics(
    repo_root: &Path,
    files_in_root: &HashSet<String>,
    patterns: &crate::domain::repo_type::PatternRules,
) -> bool {
    let globs = &patterns.match_globs;
    if globs.is_empty() {
        return true;
    }
    if files_in_root.iter().any(|f| globs.iter().any(|p| fnmatch(f, p))) {
        return true;
    }
    for dir in &patterns.search_dirs {
        let target = repo_root.join(dir);
        if !target.is_dir() {
            continue;
        }
        if plain_file_names(&target)
            .iter()
            .any(|f| globs.iter().any(|p| fnmatch(f, p)))
        {
            return true;
        }
    }
    false
}

/// `must_match_package_json`: every listed package name must appear in
/// `dependencies` or `devDependencies` of the root `package.json`. A missing
/// or unparsable `package.json` fails the gate (architecture-v2.md §7 fix 3 —
/// this is what stops plain Node servers from classifying as react).
fn check_package_json(repo_root: &Path, required: &[String]) -> bool {
    if required.is_empty() {
        return true;
    }
    let Ok(raw) = fs::read_to_string(repo_root.join("package.json")) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    required.iter().all(|name| {
        ["dependencies", "devDependencies"]
            .iter()
            .any(|section| value.get(section).and_then(|deps| deps.get(name)).is_some())
    })
}

/// Classify one candidate directory: first definition (caller passes them
/// pre-sorted by priority — `config::repo_types_loader`) passing all gates
/// wins; no match → `None`, the directory is ignored
/// (project_analyzer.py:80-95).
pub fn classify_repo(name: &str, path: &Path, defs: &[RepoTypeDef]) -> Option<RepoInfo> {
    let files_in_root = plain_file_names(path).into_iter().collect::<HashSet<_>>();
    defs.iter()
        .filter(|def| !def.type_id.is_empty())
        .find(|def| matches_definition(path, &files_in_root, def))
        .map(|def| build_repo_info(name, path, def))
}

/// Scan one workspace root (v1 `detect_repos`, project_analyzer.py:35-63):
/// - non-directory workspace → empty;
/// - candidates = direct child directories, sorted alphabetically, skipping
///   names starting with `.` and `node_modules` (v1 also skipped the tool's
///   own install dir — moot in v2, the app does not live in the workspace);
/// - classification runs concurrently, capped at
///   [`MAX_CLASSIFY_CONCURRENCY`], result order stays alphabetical (v1 used
///   `executor.map`, NOT `as_completed`, exactly for the order guarantee);
/// - unmatched directories are dropped;
/// - `on_progress` (when given) fires after EACH candidate finishes
///   classifying, with `(repos detected so far, total candidates)`.
pub async fn detect_repos(
    workspace_dir: &Path,
    defs: &[RepoTypeDef],
    on_progress: Option<&ScanProgressFn>,
) -> Vec<RepoInfo> {
    if !workspace_dir.is_dir() {
        return Vec::new();
    }
    let mut candidates: Vec<(String, PathBuf)> = match fs::read_dir(workspace_dir) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .filter_map(|p| {
                p.file_name()
                    .map(|n| (n.to_string_lossy().into_owned(), p.clone()))
            })
            .filter(|(name, _)| !name.starts_with('.') && name != "node_modules")
            .collect(),
        Err(_) => return Vec::new(),
    };
    candidates.sort_by(|a, b| a.0.cmp(&b.0));

    let defs: Arc<Vec<RepoTypeDef>> = Arc::new(defs.to_vec());
    let semaphore = Arc::new(Semaphore::new(MAX_CLASSIFY_CONCURRENCY));

    // One task per candidate; awaiting the handles IN SPAWN ORDER preserves
    // the alphabetical result order while the semaphore caps the actual
    // filesystem work at 8 (spawn_blocking keeps walks off the async runtime).
    let handles: Vec<_> = candidates
        .into_iter()
        .map(|(name, path)| {
            let defs = Arc::clone(&defs);
            let semaphore = Arc::clone(&semaphore);
            tokio::spawn(async move {
                let _permit = semaphore.acquire_owned().await.ok()?;
                tokio::task::spawn_blocking(move || classify_repo(&name, &path, &defs))
                    .await
                    .ok()
                    .flatten()
            })
        })
        .collect();

    let total = handles.len() as u32;
    let mut repos = Vec::new();
    for handle in handles {
        if let Ok(Some(repo)) = handle.await {
            repos.push(repo);
        }
        // Progress after each candidate, regardless of match — handles are
        // awaited in spawn (alphabetical) order, so this advances steadily.
        if let Some(progress) = on_progress {
            progress(repos.len() as u32, total);
        }
    }
    repos
}

/// Scan all roots of a workspace group (v1 `detect_repos_for_group`,
/// project_analyzer.py:65-78): skips empty/non-directory paths, unions the
/// results, deduplicates by `repo.path` (first occurrence wins), and sorts
/// the combined list by lowercased name.
///
/// `on_progress` is forwarded to [`detect_repos`] per root — with multiple
/// roots the `(detected, total)` pair restarts per root (the terminal
/// `"done"` event from the commands layer carries the final combined count).
pub async fn detect_repos_for_group(
    paths: &[String],
    defs: &[RepoTypeDef],
    on_progress: Option<&ScanProgressFn>,
) -> Vec<RepoInfo> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut combined: Vec<RepoInfo> = Vec::new();
    for path in paths {
        if path.is_empty() {
            continue;
        }
        let root = Path::new(path);
        if !root.is_dir() {
            continue;
        }
        for repo in detect_repos(root, defs, on_progress).await {
            if seen.insert(repo.path.clone()) {
                combined.push(repo);
            }
        }
    }
    disambiguate_names(&mut combined);
    combined.sort_by_key(|r| r.name.to_lowercase());
    combined
}

/// `name` is the repo identity everywhere downstream (card state, config
/// keys `"repo::module"`, profiles, docker/badge event routing): two roots
/// containing repos with the same basename would collapse into ONE identity
/// — every UI action on one card mirrors on the other. Qualify colliding
/// names with parent directories until unique: `api (backend)`,
/// `api (clients/backend)`, …
fn disambiguate_names(repos: &mut [RepoInfo]) {
    // ponytail: 8 parent levels is plenty; deeper collisions stay duplicated
    for depth in 1..=8 {
        let mut counts: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        for repo in repos.iter() {
            *counts.entry(repo.name.to_lowercase()).or_default() += 1;
        }
        if counts.values().all(|&n| n == 1) {
            return;
        }
        for repo in repos.iter_mut() {
            if counts[&repo.name.to_lowercase()] > 1 {
                repo.name = qualified_name(Path::new(&repo.path), depth);
            }
        }
    }
}

/// `<basename> (<last `depth` parent dirs, joined with `/`>)`.
fn qualified_name(path: &Path, depth: usize) -> String {
    let base = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    let mut parents: Vec<String> = path
        .ancestors()
        .skip(1)
        .filter_map(|a| a.file_name())
        .take(depth)
        .map(|n| n.to_string_lossy().into_owned())
        .collect();
    if parents.is_empty() {
        return base;
    }
    parents.reverse();
    format!("{} ({})", base, parents.join("/"))
}

/// Plain-file basenames directly inside one directory.
fn plain_file_names(dir: &Path) -> Vec<String> {
    match fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| e.path().is_file())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::repo_types_loader::sort_by_priority;

    fn shipped_defs() -> Vec<RepoTypeDef> {
        let mut defs: Vec<RepoTypeDef> = [
            include_str!("../../../config/repo-types/angular.yml"),
            include_str!("../../../config/repo-types/docker-infra.yml"),
            include_str!("../../../config/repo-types/maven-lib.yml"),
            include_str!("../../../config/repo-types/nx-workspace.yml"),
            include_str!("../../../config/repo-types/react.yml"),
            include_str!("../../../config/repo-types/spring-boot.yml"),
        ]
        .iter()
        .map(|src| serde_yaml_ng::from_str(src).expect("shipped def parses"))
        .collect();
        sort_by_priority(&mut defs);
        defs
    }

    fn temp_ws(test: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dm2-pipeline-{}-{}",
            std::process::id(),
            test
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn make_git(repo: &Path) {
        fs::create_dir_all(repo.join(".git")).unwrap();
    }

    fn make_spring(ws: &Path, name: &str) {
        let repo = ws.join(name);
        make_git(&repo);
        write(&repo, "pom.xml", "<project/>");
        write(&repo, "src/main/resources/application.yml", "server:\n  port: 8080\n");
    }

    fn make_react(ws: &Path, name: &str) {
        let repo = ws.join(name);
        make_git(&repo);
        write(
            &repo,
            "package.json",
            r#"{ "dependencies": { "react": "^18.0.0", "react-dom": "^18.0.0" } }"#,
        );
    }

    #[tokio::test]
    async fn classifies_synthetic_workspace_alphabetically() {
        let ws = temp_ws("workspace");
        make_spring(&ws, "zeta-service");
        make_react(&ws, "alpha-front");
        // docker-infra without .git (allow_no_git).
        write(&ws.join("infra"), "docker-compose.yml", "services: {}");
        // Skipped: hidden, node_modules, plain unmatched dir.
        fs::create_dir_all(ws.join(".hidden")).unwrap();
        fs::create_dir_all(ws.join("node_modules")).unwrap();
        fs::create_dir_all(ws.join("just-a-dir")).unwrap();

        // Track progressive (detected, total) callbacks too.
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(u32, u32)>::new()));
        let calls_in = calls.clone();
        let on_progress = move |detected: u32, total: u32| {
            calls_in.lock().unwrap().push((detected, total));
        };
        let repos = detect_repos(&ws, &shipped_defs(), Some(&on_progress)).await;
        // 6 candidates (3 matching + just-a-dir + … minus hidden/node_modules
        // = 4 candidates), one callback per candidate, monotonic detected.
        let recorded = calls.lock().unwrap().clone();
        assert_eq!(recorded.len(), 4, "one progress call per candidate");
        assert!(recorded.iter().all(|(_, total)| *total == 4));
        assert_eq!(recorded.last(), Some(&(3, 4)));
        let summary: Vec<(&str, &str)> = repos
            .iter()
            .map(|r| (r.name.as_str(), r.repo_type.as_str()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("alpha-front", "react"),
                ("infra", "docker-infra"),
                ("zeta-service", "spring-boot"),
            ]
        );
        let _ = fs::remove_dir_all(ws);
    }

    #[tokio::test]
    async fn same_basename_in_two_roots_gets_disambiguated_names() {
        let ws = temp_ws("dupnames");
        let (root_a, root_b) = (ws.join("backend"), ws.join("fork"));
        make_spring(&root_a, "api");
        make_spring(&root_b, "api");
        make_react(&root_a, "web"); // no collision → untouched

        let repos = detect_repos_for_group(
            &[root_a.display().to_string(), root_b.display().to_string()],
            &shipped_defs(),
            None,
        )
        .await;

        let names: Vec<&str> = repos.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["api (backend)", "api (fork)", "web"]);
        let _ = fs::remove_dir_all(ws);
    }

    #[test]
    fn qualified_name_deepens_until_parents_differ() {
        assert_eq!(qualified_name(Path::new("/ws/backend/api"), 1), "api (backend)");
        assert_eq!(
            qualified_name(Path::new("/ws/backend/api"), 2),
            "api (ws/backend)"
        );
        // Same parent name, different grandparent → depth 2 resolves it.
        let mut repos = vec![
            RepoInfo {
                name: "api".into(),
                path: "/one/backend/api".into(),
                ..Default::default()
            },
            RepoInfo {
                name: "api".into(),
                path: "/two/backend/api".into(),
                ..Default::default()
            },
        ];
        disambiguate_names(&mut repos);
        assert_eq!(repos[0].name, "api (one/backend)");
        assert_eq!(repos[1].name, "api (two/backend)");
    }

    #[tokio::test]
    async fn non_directory_workspace_is_empty() {
        let repos = detect_repos(Path::new("/definitely/not/here"), &shipped_defs(), None).await;
        assert!(repos.is_empty());
    }

    #[test]
    fn git_gate_blocks_all_but_allow_no_git() {
        let ws = temp_ws("gitgate");
        // spring repo WITHOUT .git → no match at all.
        let repo = ws.join("no-git-spring");
        write(&repo, "pom.xml", "<project/>");
        write(&repo, "src/main/resources/application.yml", "a: 1");
        assert!(classify_repo("no-git-spring", &repo, &shipped_defs()).is_none());
        // Same content WITH .git → spring-boot.
        make_git(&repo);
        let info = classify_repo("no-git-spring", &repo, &shipped_defs()).unwrap();
        assert_eq!(info.repo_type, "spring-boot");
        let _ = fs::remove_dir_all(ws);
    }

    #[test]
    fn must_match_package_json_is_enforced() {
        let ws = temp_ws("pkgjson");
        // Plain Node server: package.json without react deps — v1 classified
        // this as react (§22.5); v2 must NOT.
        let node = ws.join("node-api");
        make_git(&node);
        write(&node, "package.json", r#"{ "dependencies": { "express": "^4" } }"#);
        assert!(classify_repo("node-api", &node, &shipped_defs()).is_none());

        // react dep present in devDependencies counts too.
        let dev = ws.join("react-dev");
        make_git(&dev);
        write(
            &dev,
            "package.json",
            r#"{ "devDependencies": { "react": "18", "react-dom": "18" } }"#,
        );
        assert_eq!(
            classify_repo("react-dev", &dev, &shipped_defs()).unwrap().repo_type,
            "react"
        );

        // Broken package.json fails the gate instead of panicking.
        let broken = ws.join("broken");
        make_git(&broken);
        write(&broken, "package.json", "{ not json");
        assert!(classify_repo("broken", &broken, &shipped_defs()).is_none());
        let _ = fs::remove_dir_all(ws);
    }

    #[test]
    fn priority_ladder_resolves_overlaps() {
        let ws = temp_ws("ladder");
        // angular.json beats react (exclude_files + priority).
        let ng = ws.join("ng-app");
        make_git(&ng);
        write(&ng, "package.json", r#"{ "dependencies": { "react": "1", "react-dom": "1" } }"#);
        write(&ng, "angular.json", "{}");
        assert_eq!(classify_repo("ng-app", &ng, &shipped_defs()).unwrap().repo_type, "angular");

        // nx.json beats angular (priority 50 > 40 needs both files; here only nx).
        let nx = ws.join("nx-ws");
        make_git(&nx);
        write(&nx, "package.json", "{}");
        write(&nx, "nx.json", "{}");
        assert_eq!(
            classify_repo("nx-ws", &nx, &shipped_defs()).unwrap().repo_type,
            "nx-workspace"
        );

        // pom.xml + src without resources dir → maven-lib, not spring-boot.
        let lib = ws.join("lib");
        make_git(&lib);
        write(&lib, "pom.xml", "<project/>");
        fs::create_dir_all(lib.join("src/main/java")).unwrap();
        assert_eq!(
            classify_repo("lib", &lib, &shipped_defs()).unwrap().repo_type,
            "maven-lib"
        );
        let _ = fs::remove_dir_all(ws);
    }

    #[test]
    fn pattern_search_dirs_fallback_replaces_spring_special_case() {
        let ws = temp_ws("patterndirs");
        // application*.yml only under src/main/resources, NOT at root —
        // matches via pattern_search_dirs (v1 hardcoded fallback).
        let repo = ws.join("svc");
        make_git(&repo);
        write(&repo, "pom.xml", "<project/>");
        write(&repo, "src/main/resources/application-dev.yml", "a: 1");
        let info = classify_repo("svc", &repo, &shipped_defs()).unwrap();
        assert_eq!(info.repo_type, "spring-boot");
        assert_eq!(info.profiles, vec!["dev"]);

        // Without any application file anywhere, spring-boot fails the
        // pattern gate and maven-lib's must_not_have_directories also fails
        // (resources dir exists) → unmatched.
        let bare = ws.join("bare");
        make_git(&bare);
        write(&bare, "pom.xml", "<project/>");
        fs::create_dir_all(bare.join("src/main/resources")).unwrap();
        assert!(classify_repo("bare", &bare, &shipped_defs()).is_none());
        let _ = fs::remove_dir_all(ws);
    }

    #[tokio::test]
    async fn group_scan_dedups_by_path_and_sorts_case_insensitively() {
        let ws = temp_ws("group");
        make_spring(&ws, "Beta-svc");
        make_react(&ws, "alpha-front");
        let ws_str = ws.display().to_string();
        // Same root listed twice + one bogus path → no duplicates, no errors.
        let paths = vec![ws_str.clone(), String::new(), ws_str.clone(), "/nope".into()];
        let repos = detect_repos_for_group(&paths, &shipped_defs(), None).await;
        let names: Vec<&str> = repos.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["alpha-front", "Beta-svc"]);
        let _ = fs::remove_dir_all(ws);
    }
}

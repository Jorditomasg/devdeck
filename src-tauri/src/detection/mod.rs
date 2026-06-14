//! Config-driven repository detection — the ONE unified detector.
//!
//! Replaces BOTH v1 paths: `application/services/project_analyzer.py`
//! (inventory-backend.md §6) and the broken legacy `core/repo_detector.py`
//! (§16, §22.3). Responsibilities:
//! - Repo-type YAML definitions are loaded/merged by
//!   `config::repo_types_loader` (bundled Tauri resources + user overrides in
//!   `dirs::config_dir()/devdeck/repo-types/`, architecture-v2.md §5)
//!   and passed in pre-sorted by priority.
//! - Matching pipeline in exact v1 order (git gate, required/exclude files,
//!   directory heuristics, pattern heuristics — inventory-config-ci.md §1.3),
//!   with the hardcoded type-name special cases expressed as schema flags and
//!   `must_match_package_json` actually implemented ([`pipeline`]).
//! - Concurrent classification capped at 8, preserving alphabetical order
//!   (inventory-backend.md §6.2); group scan dedup by path (§6.3).
//! - Legacy-detector enrichments merged in (§22.4): java_version from pom.xml,
//!   static server_port/context_path from Spring config, git remote URL
//!   ([`enrich`]).
//! - Env-file resolution: default_dir fast path, walk fallback with
//!   exclude_dirs pruning, profile-name extraction (§6.6) ([`env_files`]).

pub mod builder;
pub mod enrich;
pub mod env_files;
pub mod glob;
pub mod pipeline;

pub use builder::{build_repo_info, find_docker_compose_files, resolve_main_app, resolve_run_command};
pub use enrich::{
    extract_java_version_from_pom, git_remote_url, java_version_for_repo, normalize_remote_url,
    spring_server_info, SpringServerInfo,
};
pub use env_files::{extract_profile_from_filename, resolve_env_files, EnvScan};
pub use glob::fnmatch;
pub use pipeline::{
    classify_repo, detect_repos, detect_repos_for_group, matches_definition, ScanProgressFn,
    MAX_CLASSIFY_CONCURRENCY,
};

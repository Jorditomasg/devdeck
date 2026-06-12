//! Pure domain types — no tauri/tokio/IO imports allowed here.
//!
//! Implemented per the migration contract (`docs/migration/inventory-backend.md`,
//! `docs/migration/inventory-config-ci.md`, `docs/migration/architecture-v2.md`):
//! - [`RepoInfo`] / [`RepoModule`] — all detected metadata for one repository,
//!   superset of v1 (inventory-backend.md §2) including the enrichment fields
//!   only the broken legacy detector populated (`java_version`, `server_port`,
//!   `context_path`, `git_remote_url` — §22.4).
//! - [`RepoTypeDef`] — the repo-type YAML schema (inventory-config-ci.md §1.2)
//!   extended with the v2 schema flags from architecture-v2.md §5
//!   (`detection.allow_no_git`, `heuristics.pattern_search_dirs`,
//!   `env_files.implicit_default_profile`, `windows_/unix_reinstall_cmd`) and
//!   the formerly-dead keys `must_match_package_json` / `stop_cmd`, which now
//!   round-trip AND are enforced (detection / process layers respectively).
//! - [`ServiceStatus`] — the 6-state service lifecycle, typed.
//! - [`DomainError`] — thiserror-based error model replacing v1's swallowed
//!   exceptions / `(bool, str)` tuples (inventory-backend.md §5).
//!
//! Other domain types (`RunningService`, `ProfileDocument`, `MergeOutcome`,
//! `RevertPoint`) are owned by the process/profiles/git tasks and are added
//! by them.

pub mod error;
pub mod op_output;
pub mod repo_info;
pub mod repo_type;
pub mod service_status;

pub use error::{DomainError, DomainResult};
pub use op_output::{LogSink, OpOutput};
pub use repo_info::{RepoInfo, RepoModule};
pub use repo_type::{
    CommandsDef, DetectionRules, EnvFilesDef, Heuristics, RepoTypeDef, UiConfig, UiInstall,
    UiSelector,
};
pub use service_status::ServiceStatus;

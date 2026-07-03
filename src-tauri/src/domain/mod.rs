//! Pure domain types — no tauri/tokio/IO imports allowed here.
//!
//! Implemented per the migration contract (`docs/migration/inventory-backend.md`,
//! `docs/migration/inventory-config-ci.md`, `docs/migration/architecture-v2.md`):
//! - [`RepoInfo`] / [`RepoModule`] — all detected metadata for one repository,
//!   superset of v1 (inventory-backend.md §2) including the enrichment fields
//!   only the broken legacy detector populated (`java_version`, `server_port`,
//!   `context_path`, `git_remote_url` — §22.4).
//! - [`RepoTypeDef`] — the v2 six-block repo-type YAML schema
//!   (`detect / run / logs / config / enrich / ui`), gated on
//!   `schema_version: 2`. Behavior is selected by name from named-strategy
//!   registries (config writers, enrichers, app-resolution)
//!   instead of `if repo_type == "..."` hardcodes
//!   (`docs/superpowers/specs/2026-06-21-repo-types-v2-design.md`).
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
    AppResolution, ConfigSpec, Detect, DirRules, FileRules, Logs, OsCommand, PatternRules,
    RepoTypeDef, Run, Ui, UiSelector,
};
pub use service_status::ServiceStatus;

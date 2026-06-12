//! JDK discovery and per-service environment injection.
//!
//! Replaces `core/java_manager.py` (inventory-backend.md §13):
//! - Scan the platform JDK base dirs (Program Files vendors + `~/.jdks` on
//!   Windows; `/usr/lib/jvm`, macOS JavaVirtualMachines bundle layout,
//!   `~/.sdkman` on POSIX), validate via `java -version` (2 s timeout, version
//!   printed on stderr), label as `"Java {ver} ({dirname})"`, include a valid
//!   `JAVA_HOME` env entry.
//! - Build the launch environment for Java services: set `JAVA_HOME` and
//!   prepend `<home>/bin` to `PATH` (consumed by `process/`).
//! - The persisted JDK registry stays in config key `java_versions`
//!   (inventory-backend.md §8.3); recommended version comes from pom.xml via
//!   `detection/` enrichment.
//!
//! Layout: [`parse`] (pure `java -version` banner parsing), [`detect`]
//! (filesystem scan + validation subprocesses), [`env`] (launch overrides).
//! Discovery never fails — invalid candidates are skipped, exactly like v1's
//! swallowed exceptions (§5), so no module error type is needed.

pub mod detect;
pub mod env;
pub mod parse;

pub use detect::{auto_detect_java_paths, detect_java_version, search_paths, JAVA_VERSION_TIMEOUT};
pub use env::{build_java_env, build_java_env_with, PATH_SEPARATOR};
pub use parse::{java_label, parse_java_version, simplify_java_version};

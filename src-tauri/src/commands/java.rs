//! Java commands (ipc-contract.md §2.6) — JDK discovery and the persisted
//! `java_versions` registry. The registry itself is READ via
//! `get_app_config().java_versions`; label → env resolution happens inside
//! `start_service` (commands/process.rs).

use std::collections::BTreeMap;

use tauri::State;

use super::error::CmdResult;
use crate::java;
use crate::state::AppState;

/// #37 `detect_jdks` → `Record<string, string>` (label → JAVA_HOME).
///
/// Never errors — invalid candidates are skipped, exactly like v1's
/// swallowed exceptions (inventory-backend.md §13, §5).
#[tauri::command]
pub async fn detect_jdks() -> CmdResult<BTreeMap<String, String>> {
    Ok(java::auto_detect_java_paths().await)
}

/// #38 `save_java_versions { versions }` — whole-map replace of the
/// `java_versions` registry (inventory-backend.md §8.3).
#[tauri::command]
pub async fn save_java_versions(
    state: State<'_, AppState>,
    versions: BTreeMap<String, String>,
) -> CmdResult<()> {
    state.config.update(|c| c.java_versions = versions)?;
    Ok(())
}

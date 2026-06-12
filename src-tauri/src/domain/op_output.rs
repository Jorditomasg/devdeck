//! Shared operation-result types for the git and docker adapter layers.
//!
//! v1 returned `(bool, str)` tuples and threaded optional log callbacks
//! through every operation (inventory-backend.md §5, §9, §10.3). Both the
//! git and docker modules originally carried identical private copies of
//! these types (their `TODO(integration)` notes); this is the unified
//! definition — `git::types` and `docker::types` re-export it, so the
//! wire shape (`{ ok, message }`, camelCase) is defined exactly once.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// Callback receiving human-readable log lines (v1 `LogCallback`).
/// The commands layer routes these to `events::SERVICE_LOG_LINE`
/// (`stream: "git"` / `"docker"` depending on the caller).
pub type LogSink = Arc<dyn Fn(&str) + Send + Sync>;

/// Emit a line to an optional sink (v1's `if log: log(...)` idiom).
pub fn emit(log: Option<&LogSink>, msg: &str) {
    if let Some(sink) = log {
        sink(msg);
    }
}

/// `(ok, message)` result of a mutating git/docker operation — the typed
/// version of v1's `tuple[bool, str]` contract (inventory-backend.md §9,
/// §10.3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpOutput {
    pub ok: bool,
    pub message: String,
}

impl OpOutput {
    pub fn ok(message: impl Into<String>) -> Self {
        Self { ok: true, message: message.into() }
    }
    pub fn fail(message: impl Into<String>) -> Self {
        Self { ok: false, message: message.into() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_output_serializes_camel_case() {
        let json = serde_json::to_value(OpOutput::ok("done")).unwrap();
        assert_eq!(json, serde_json::json!({ "ok": true, "message": "done" }));
        let json = serde_json::to_value(OpOutput::fail("boom")).unwrap();
        assert_eq!(json, serde_json::json!({ "ok": false, "message": "boom" }));
    }
}

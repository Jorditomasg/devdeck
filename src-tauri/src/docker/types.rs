//! Docker module types — results, parsed compose model and error model.
//!
//! `LogSink` / `OpOutput` are the shared `crate::domain::op_output` types
//! (the commands layer routes log lines to `events::SERVICE_LOG_LINE` with
//! `stream: "docker"`), re-exported here so existing `docker::types::*`
//! imports keep working.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use crate::domain::op_output::{LogSink, OpOutput};
pub(crate) use crate::domain::op_output::emit;

/// Errors from the docker executor (spawn/timeout). Public ops fold these
/// into [`OpOutput`] / defaults, like v1's swallowed exceptions (§5 backend).
#[derive(Debug, Error)]
pub enum DockerError {
    /// The `docker` / `docker-compose` binary could not be spawned.
    #[error("failed to run docker: {0}")]
    Spawn(String),
    /// The command exceeded its v1 timeout (inventory-backend.md §21.5).
    #[error("docker command timed out after {0} s")]
    Timeout(u64),
}

/// One running container from `docker ps` (v1 `_parse_container_line`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub name: String,
    pub status: String,
    /// `""` when `docker ps` printed no ports column for the row.
    pub ports: String,
}

/// One service definition from a compose file
/// (v1 `parse_compose_services`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComposeService {
    pub name: String,
    /// `image:` value, falling back to a string `build:` value, else the
    /// literal `unknown` (v1 stored a raw dict for mapping `build:` forms —
    /// v2 normalizes those to `unknown` too).
    pub image: String,
    pub ports: Vec<String>,
    /// Handles both the list and the map `depends_on` forms.
    pub depends_on: Vec<String>,
}

//! Docker / docker-compose operations.
//!
//! Replaces `core/db_manager.py` (inventory-backend.md §9):
//! - Availability + container queries (`docker info`, `docker ps` parsing).
//! - Compose file parsing (services, images, ports, depends_on — both list
//!   and map forms) via serde_yaml_ng.
//! - Compose up/down/stop per service or stack, MySQL helpers, with the v1
//!   timeout table (queries 10 s, up 120 s, down/stop 60 s).
//! - Modernization decided in architecture-v2.md: try `docker compose` (v2
//!   CLI) first, fall back to the legacy `docker-compose` binary v1 used.
//! - The 15 s per-repo compose status poll lives HERE, emitting
//!   `events::DOCKER_STATUS` (inventory-gui.md §28 — do not lower).
//!
//! Layout: [`exec`] (the only process spawner; owns the
//! `docker compose` → `docker-compose` fallback probe), [`parse`] (pure,
//! unit-tested parsers), [`types`] (results/errors), [`ops`] (the v1
//! `db_manager.py` operation surface), [`poll`] (status loop).

mod exec;
pub mod ops;
pub mod parse;
pub mod poll;
pub mod types;

pub use ops::{
    docker_compose_down, docker_compose_logs, docker_compose_up, find_compose_file,
    get_compose_service_status, get_running_containers, is_container_running,
    is_docker_available, is_mysql_running, parse_compose_services, start_mysql,
    start_service_compose, stop_mysql, stop_service_compose,
};
pub use poll::{refresh_status, spawn_status_poller, StatusPoller, StatusTarget, DOCKER_POLL};
pub use types::{ComposeService, ContainerInfo, DockerError, LogSink, OpOutput};

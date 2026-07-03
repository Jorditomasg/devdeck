//! Pure docker/compose output parsers — no process execution.
//!
//! Each function implements the exact v1 parsing rules from
//! inventory-backend.md §9 (`core/db_manager.py`).

use std::collections::BTreeMap;

use serde_yaml_ng::Value;

use crate::events::DockerServiceState;

use super::types::{ComposeService, ContainerInfo};

/// Parse one `docker ps --format {{.Names}}\t{{.Status}}\t{{.Ports}}` line
/// (v1 `_parse_container_line`): needs ≥ 2 tab-separated parts; ports
/// optional (`""`); when `project_prefix` is non-empty, keep only names
/// CONTAINING it.
pub fn parse_container_line(line: &str, project_prefix: &str) -> Option<ContainerInfo> {
    let parts: Vec<&str> = line.split('\t').collect();
    if parts.len() < 2 {
        return None;
    }
    let name = parts[0];
    if !project_prefix.is_empty() && !name.contains(project_prefix) {
        return None;
    }
    Some(ContainerInfo {
        name: name.to_string(),
        status: parts[1].to_string(),
        ports: parts.get(2).unwrap_or(&"").to_string(),
    })
}

/// Parse the whole `docker ps` output (v1 `get_running_containers`).
pub fn parse_running_containers(stdout: &str, project_prefix: &str) -> Vec<ContainerInfo> {
    stdout
        .trim()
        .lines()
        .filter_map(|line| parse_container_line(line, project_prefix))
        .collect()
}

/// Parse a docker-compose YAML document into its service list
/// (v1 `parse_compose_services`):
/// - `image` falls back to a string `build:` value, else `"unknown"`
///   (v1 stored the raw dict for mapping `build:` forms — normalized here);
/// - `ports` entries stringified (`3306:3306`, bare numbers, long form maps
///   are skipped — v1's `str(p)` of a dict is useless downstream);
/// - `depends_on` accepts BOTH the list form and the map
///   (`service: {condition: …}`) form.
///
/// Walks the raw YAML `Value` so the file's service order is preserved
/// (serde_yaml_ng mappings keep insertion order, like Python dicts).
pub fn parse_compose_yaml(content: &str) -> Result<Vec<ComposeService>, serde_yaml_ng::Error> {
    let doc: Value = serde_yaml_ng::from_str(content)?;
    let mut services = Vec::new();
    let Some(services_map) = doc.get("services").and_then(Value::as_mapping) else {
        return Ok(services);
    };
    for (name, config) in services_map {
        let Some(name) = name.as_str() else { continue };
        services.push(ComposeService {
            name: name.to_string(),
            image: image_of(config),
            ports: ports_of(config),
            depends_on: depends_on_of(config),
        });
    }
    Ok(services)
}

fn image_of(config: &Value) -> String {
    if let Some(image) = config.get("image").and_then(Value::as_str) {
        return image.to_string();
    }
    if let Some(build) = config.get("build").and_then(Value::as_str) {
        return build.to_string();
    }
    "unknown".to_string()
}

fn ports_of(config: &Value) -> Vec<String> {
    let Some(ports) = config.get("ports").and_then(Value::as_sequence) else {
        return Vec::new();
    };
    ports.iter().filter_map(scalar_to_string).collect()
}

fn scalar_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn depends_on_of(config: &Value) -> Vec<String> {
    match config.get("depends_on") {
        Some(Value::Sequence(list)) => list.iter().filter_map(scalar_to_string).collect(),
        Some(Value::Mapping(map)) => map
            .keys()
            .filter_map(|k| k.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

/// Build the `{service: running|stopped}` map from the full service list and
/// the `compose ps --services --filter status=running` output: services not
/// reported running are `stopped` (v1 `get_compose_service_status`).
pub fn build_status_map(
    all_services: &[ComposeService],
    running_stdout: &str,
) -> BTreeMap<String, DockerServiceState> {
    let running: Vec<&str> = running_stdout
        .trim()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    all_services
        .iter()
        .map(|s| {
            let state = if running.contains(&s.name.as_str()) {
                DockerServiceState::Running
            } else {
                DockerServiceState::Stopped
            };
            (s.name.clone(), state)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- docker ps -------------------------------------------------------

    #[test]
    fn container_lines_parse_with_optional_ports() {
        let line = "boa2-mysqldb-1\tUp 3 hours\t0.0.0.0:3306->3306/tcp";
        let c = parse_container_line(line, "").unwrap();
        assert_eq!(c.name, "boa2-mysqldb-1");
        assert_eq!(c.status, "Up 3 hours");
        assert_eq!(c.ports, "0.0.0.0:3306->3306/tcp");

        let no_ports = parse_container_line("svc\tUp 2 minutes", "").unwrap();
        assert_eq!(no_ports.ports, "");

        assert!(parse_container_line("only-one-field", "").is_none());
    }

    #[test]
    fn project_prefix_filters_by_substring() {
        let stdout = "boa2-mysqldb-1\tUp\nother-app\tUp\nmy-boa2-extra\tUp\n";
        let filtered = parse_running_containers(stdout, "boa2");
        let names: Vec<&str> = filtered.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["boa2-mysqldb-1", "my-boa2-extra"]);
        assert_eq!(parse_running_containers(stdout, "").len(), 3);
    }

    // ---- compose YAML ------------------------------------------------------

    const COMPOSE_LIST_FORM: &str = "\
services:
  mysqldb:
    image: mysql:8.0
    ports:
      - \"3306:3306\"
      - 33060
  flyway-seed:
    image: flyway/flyway:9
    depends_on:
      - mysqldb
  app:
    build: ./app
    depends_on:
      - mysqldb
      - flyway-seed
";

    const COMPOSE_MAP_FORM: &str = "\
services:
  mysqldb:
    image: mysql:8.0
  flyway:
    image: flyway/flyway
    depends_on:
      mysqldb:
        condition: service_healthy
  weird:
    build:
      context: .
      dockerfile: Dockerfile
";

    #[test]
    fn compose_list_form_parses_services_in_file_order() {
        let services = parse_compose_yaml(COMPOSE_LIST_FORM).unwrap();
        let names: Vec<&str> = services.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["mysqldb", "flyway-seed", "app"]);

        assert_eq!(services[0].image, "mysql:8.0");
        assert_eq!(services[0].ports, vec!["3306:3306", "33060"]);
        assert_eq!(services[1].depends_on, vec!["mysqldb"]);
        assert_eq!(services[2].image, "./app", "string build value is the image fallback");
        assert_eq!(services[2].depends_on, vec!["mysqldb", "flyway-seed"]);
    }

    #[test]
    fn compose_map_form_depends_on_and_mapping_build() {
        let services = parse_compose_yaml(COMPOSE_MAP_FORM).unwrap();
        assert_eq!(services[1].name, "flyway");
        assert_eq!(services[1].depends_on, vec!["mysqldb"], "map form → keys");
        assert_eq!(services[2].image, "unknown", "mapping build → unknown");
    }

    #[test]
    fn compose_without_services_is_empty() {
        assert!(parse_compose_yaml("version: '3'\n").unwrap().is_empty());
        assert!(parse_compose_yaml("").unwrap().is_empty());
        assert!(parse_compose_yaml("services: {}\n").unwrap().is_empty());
    }

    #[test]
    fn compose_invalid_yaml_is_an_error() {
        assert!(parse_compose_yaml("services:\n  bad: [unclosed").is_err());
    }

    // ---- status map --------------------------------------------------------

    #[test]
    fn status_map_marks_missing_services_stopped() {
        let services = parse_compose_yaml(COMPOSE_LIST_FORM).unwrap();
        let map = build_status_map(&services, "mysqldb\n");
        assert_eq!(map["mysqldb"], DockerServiceState::Running);
        assert_eq!(map["flyway-seed"], DockerServiceState::Stopped);
        assert_eq!(map["app"], DockerServiceState::Stopped);

        let none = build_status_map(&services, "\n");
        assert!(none.values().all(|s| *s == DockerServiceState::Stopped));
    }
}

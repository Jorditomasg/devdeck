//! `RepoInfo` construction from a matched repo-type definition.
//!
//! Port of `_build_repo_info` / `_resolve_run_command` /
//! `_find_docker_compose_files` (project_analyzer.py:171-237,
//! inventory-backend.md §6.6) MERGED with the legacy-detector enrichments
//! (§16, §22.4) — v2 ships exactly one detector (architecture-v2.md §7
//! fix 2).

use crate::detection::enrich;
use crate::detection::env_files::resolve_env_files;
use crate::detection::glob::fnmatch;
use crate::domain::{CommandsDef, RepoInfo, RepoTypeDef};
use std::fs;
use std::path::Path;

/// Build the full [`RepoInfo`] for a directory that matched `def`.
pub fn build_repo_info(name: &str, path: &Path, def: &RepoTypeDef) -> RepoInfo {
    let scan = resolve_env_files(path, &def.env_files);

    let mut repo = RepoInfo {
        name: name.to_string(),
        path: path.display().to_string(),
        repo_type: def.type_id.clone(),
        run_install_cmd: def.commands.install_cmd.clone(),
        run_reinstall_cmd: def.commands.resolved_reinstall_cmd(),
        run_command: resolve_run_command(path, &def.commands),
        stop_command: def.commands.stop_cmd.clone(),
        ready_pattern: def.commands.ready_pattern.clone(),
        error_pattern: def.commands.error_pattern.clone(),
        port_patterns: def.commands.port_patterns.clone(),
        ui_config: def.ui.clone(),
        features: def.features.clone(),
        environment_files: scan.files,
        profiles: scan.profiles,
        modules: scan.modules,
        env_default_dir: def.env_files.default_dir.clone(),
        env_config_writer_type: def.env_files.config_writer_type.clone(),
        env_pull_ignore_patterns: def.env_files.pull_ignore_patterns.clone(),
        env_main_config_filename: def.env_files.main_config_filename.clone(),
        env_patterns: def.env_files.patterns.clone(),
        ..Default::default()
    };

    // Feature-gated extras (inventory-config-ci.md §1.6).
    if repo.has_feature("docker_checkboxes") {
        repo.docker_compose_files = find_docker_compose_files(path);
    }
    if repo.has_feature("java_version") {
        repo.java_version = enrich::java_version_for_repo(path);
    }

    // Legacy enrichments applied unconditionally (§22.4): Spring info fires
    // only when an `application.*` main config was found among the env files,
    // the remote URL whenever `.git/config` declares an origin.
    let spring = enrich::spring_server_info(&repo.environment_files);
    repo.server_port = spring.port;
    repo.context_path = spring.context_path;
    repo.git_remote_url = enrich::git_remote_url(path);

    repo
}

/// OS-resolved start command with `{main_app}` substitution
/// (project_analyzer.py:222-237): the placeholder is replaced with the first
/// non-hidden subdirectory of `<repo>/apps/` (fallback literal `app`),
/// wrapped in double quotes. v1 used raw `os.listdir` order (§22.15 — could
/// change across filesystems); v2 sorts alphabetically for determinism, as
/// documented in inventory-config-ci.md §1.4.
pub fn resolve_run_command(repo_root: &Path, commands: &CommandsDef) -> Option<String> {
    let cmd = commands.resolved_start_cmd()?;
    if !cmd.contains("{main_app}") {
        return Some(cmd);
    }
    let main_app = resolve_main_app(repo_root);
    Some(cmd.replace("{main_app}", &format!("\"{main_app}\"")))
}

/// First (alphabetical) non-hidden subdirectory of `<repo>/apps/`, or the
/// literal `app` when `apps/` is missing or empty.
pub fn resolve_main_app(repo_root: &Path) -> String {
    let apps_dir = repo_root.join("apps");
    let mut apps: Vec<String> = match fs::read_dir(&apps_dir) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.'))
            .collect(),
        Err(_) => return "app".to_string(),
    };
    apps.sort();
    apps.into_iter().next().unwrap_or_else(|| "app".to_string())
}

/// Absolute paths of `docker-compose*.yml` / `docker-compose*.yaml` plain
/// files in the repo root, sorted (project_analyzer.py:209-220; the
/// `.yaml`-aware variant of the two v1 paths — the legacy detector's
/// `.yml`-only check was the divergence, inventory-config-ci.md §1.6).
pub fn find_docker_compose_files(repo_root: &Path) -> Vec<String> {
    let mut files: Vec<String> = match fs::read_dir(repo_root) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .is_some_and(|n| {
                        fnmatch(&n, "docker-compose*.yml") || fnmatch(&n, "docker-compose*.yaml")
                    })
            })
            .map(|p| p.display().to_string())
            .collect(),
        Err(_) => return Vec::new(),
    };
    files.sort();
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_repo(test: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dm2-builder-{}-{}",
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

    #[test]
    fn main_app_substitution_quotes_first_apps_subdir() {
        let root = temp_repo("mainapp");
        fs::create_dir_all(root.join("apps/cart")).unwrap();
        fs::create_dir_all(root.join("apps/zeta")).unwrap();
        fs::create_dir_all(root.join("apps/.hidden")).unwrap();
        let commands = CommandsDef {
            start_cmd: Some("npx nx serve {main_app}".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_run_command(&root, &commands).as_deref(),
            Some(r#"npx nx serve "cart""#)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn main_app_falls_back_to_literal_app() {
        let root = temp_repo("mainapp-fallback");
        let commands = CommandsDef {
            start_cmd: Some("npx nx serve {main_app}".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_run_command(&root, &commands).as_deref(),
            Some(r#"npx nx serve "app""#)
        );
        // No placeholder → untouched. No start_cmd → None.
        let plain = CommandsDef {
            start_cmd: Some("npm start".into()),
            ..Default::default()
        };
        assert_eq!(resolve_run_command(&root, &plain).as_deref(), Some("npm start"));
        assert_eq!(resolve_run_command(&root, &CommandsDef::default()), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn docker_compose_files_yml_and_yaml_sorted_root_only() {
        let root = temp_repo("compose");
        write(&root, "docker-compose.yml", "services: {}");
        write(&root, "docker-compose.override.yaml", "services: {}");
        write(&root, "compose.yml", "services: {}"); // no match
        write(&root, "nested/docker-compose.yml", "services: {}"); // non-recursive
        let files = find_docker_compose_files(&root);
        assert_eq!(files.len(), 2);
        assert!(files[0].ends_with("docker-compose.override.yaml"));
        assert!(files[1].ends_with("docker-compose.yml"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn builds_enriched_spring_repo_info() {
        let root = temp_repo("spring");
        write(
            &root,
            "pom.xml",
            "<project><properties><java.version>21</java.version></properties></project>",
        );
        write(
            &root,
            "src/main/resources/application.yml",
            "server:\n  port: 8081\n  servlet:\n    context-path: /demo\n",
        );
        write(&root, "src/main/resources/application-dev.yml", "spring: {}");
        write(
            &root,
            ".git/config",
            "[remote \"origin\"]\n\turl = git@github.com:acme/demo.git\n",
        );

        let def: RepoTypeDef = serde_yaml_ng::from_str(include_str!(
            "../../../config/repo-types/spring-boot.yml"
        ))
        .unwrap();
        let repo = build_repo_info("demo", &root, &def);

        assert_eq!(repo.repo_type, "spring-boot");
        assert_eq!(repo.java_version.as_deref(), Some("21"));
        assert_eq!(repo.server_port, Some(8081));
        assert_eq!(repo.context_path.as_deref(), Some("/demo"));
        assert_eq!(
            repo.git_remote_url.as_deref(),
            Some("https://github.com/acme/demo")
        );
        assert_eq!(repo.profiles, vec!["default", "dev"]);
        assert_eq!(repo.environment_files.len(), 2);
        assert_eq!(repo.modules.len(), 1);
        assert_eq!(repo.modules[0].key, "src/main/resources");
        assert_eq!(repo.env_config_writer_type, "spring");
        assert_eq!(repo.env_main_config_filename, "application.yml");
        assert!(repo.run_command.as_deref().is_some_and(|c| c.contains("spring-boot:run")));
        // current_branch / danger_flags are NOT detection's job.
        assert_eq!(repo.current_branch, None);
        assert!(repo.danger_flags.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn docker_infra_gets_compose_files_and_stop_cmd() {
        let root = temp_repo("dockerinfra");
        write(&root, "docker-compose.yml", "services: {}");
        write(&root, ".env", "KEY=1");
        let def: RepoTypeDef = serde_yaml_ng::from_str(include_str!(
            "../../../config/repo-types/docker-infra.yml"
        ))
        .unwrap();
        let repo = build_repo_info("infra", &root, &def);
        assert_eq!(repo.docker_compose_files.len(), 1);
        assert_eq!(repo.stop_command.as_deref(), Some("docker-compose down"));
        assert_eq!(repo.environment_files.len(), 1);
        assert!(repo.profiles.is_empty(), ".env patterns extract no profiles");
        let _ = fs::remove_dir_all(root);
    }
}

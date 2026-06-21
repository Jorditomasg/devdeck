//! `RepoInfo` construction from a matched repo-type definition.
//!
//! Port of `_build_repo_info` / `_resolve_run_command` /
//! `_find_docker_compose_files` (project_analyzer.py:171-237,
//! inventory-backend.md §6.6) MERGED with the legacy-detector enrichments
//! (§16, §22.4) — v2 ships exactly one detector (architecture-v2.md §7
//! fix 2).

use crate::detection::enrich;
use crate::detection::env_files::resolve_env_files;
use crate::domain::{AppResolution, RepoInfo, RepoTypeDef, Run};
use std::fs;
use std::path::Path;

/// Build the full [`RepoInfo`] for a directory that matched `def`.
pub fn build_repo_info(name: &str, path: &Path, def: &RepoTypeDef) -> RepoInfo {
    let scan = resolve_env_files(path, &def.config);

    let mut repo = RepoInfo {
        name: name.to_string(),
        path: path.display().to_string(),
        repo_type: def.type_id.clone(),
        run_install_cmd: def.run.install.resolved(),
        run_reinstall_cmd: def.run.reinstall.resolved(),
        run_command: resolve_run_command(path, &def.run),
        stop_command: def.run.stop.resolved(),
        restart_delay_ms: def.run.restart_delay_ms,
        config_editable: def.config.editable,
        ready_pattern: def.logs.ready.clone(),
        error_pattern: def.logs.error.clone(),
        port_patterns: def.logs.ports.clone(),
        ui_config: def.ui.clone(),
        features: def.enrich.clone(),
        environment_files: scan.files,
        profiles: scan.profiles,
        modules: scan.modules,
        env_default_dir: def.config.dir.clone(),
        env_config_writer_type: def.config.writer.clone(),
        env_pull_ignore_patterns: def.config.pull_ignore.clone(),
        env_main_config_filename: def.config.main_file.clone(),
        env_patterns: def.config.patterns.clone(),
        ..Default::default()
    };

    // Enrichers selected by name from `def.enrich`, dispatched through the
    // named-strategy registry (`enrich::enricher`); unknown names are ignored
    // (the loader already validated them away — see `detection::validate`).
    for name in &def.enrich {
        if let Some(enricher) = enrich::enricher(name) {
            enricher.run(&mut repo, path);
        }
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

/// OS-resolved start command with app-resolution substitution
/// (generalizes the v1 Nx-only `{main_app}`, project_analyzer.py:222-237):
/// when `run.app_resolution` is declared and the start command contains the
/// placeholder token, it is replaced with the resolved app name (wrapped in
/// double quotes). v1 used raw `os.listdir` order (§22.15 — could change
/// across filesystems); v2 sorts alphabetically for determinism
/// (inventory-config-ci.md §1.4).
pub fn resolve_run_command(repo_root: &Path, run: &Run) -> Option<String> {
    let cmd = run.start.resolved()?;
    let Some(ar) = &run.app_resolution else {
        return Some(cmd);
    };
    let token = format!("{{{}}}", ar.placeholder); // e.g. "{main_app}"
    if !cmd.contains(&token) {
        return Some(cmd);
    }
    let app = resolve_app(repo_root, ar);
    Some(cmd.replace(&token, &format!("\"{app}\"")))
}

/// Resolve the app name for a monorepo, by the declared strategy. Falls back
/// to the literal `app` when the scan dir is missing or empty.
fn resolve_app(repo_root: &Path, ar: &AppResolution) -> String {
    let scan = repo_root.join(&ar.scan_dir);
    let mut dirs: Vec<String> = match fs::read_dir(&scan) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.'))
            .collect(),
        Err(_) => return "app".to_string(),
    };
    match ar.strategy.as_str() {
        "single_dir" => dirs.into_iter().next().unwrap_or_else(|| "app".to_string()),
        // first_alphabetical (the only other validated strategy). The catch-all
        // also covers any name that slipped past validation — defensive only.
        _ => {
            dirs.sort();
            dirs.into_iter().next().unwrap_or_else(|| "app".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::OsCommand;
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

    fn nx_run() -> Run {
        Run {
            start: OsCommand {
                default: Some("npx nx serve {main_app}".into()),
                ..Default::default()
            },
            app_resolution: Some(AppResolution {
                placeholder: "main_app".into(),
                scan_dir: "apps".into(),
                strategy: "first_alphabetical".into(),
            }),
            ..Default::default()
        }
    }

    #[test]
    fn main_app_substitution_quotes_first_apps_subdir() {
        let root = temp_repo("mainapp");
        fs::create_dir_all(root.join("apps/cart")).unwrap();
        fs::create_dir_all(root.join("apps/zeta")).unwrap();
        fs::create_dir_all(root.join("apps/.hidden")).unwrap();
        assert_eq!(
            resolve_run_command(&root, &nx_run()).as_deref(),
            Some(r#"npx nx serve "cart""#)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn app_resolution_first_alphabetical_matches_v1() {
        // Parity proof: `first_alphabetical` reproduces the v1 Nx `{main_app}`
        // behavior — the alphabetically-first non-hidden subdir of `apps` is
        // chosen and quoted. (Uses the module's temp-dir helper to match the
        // established test pattern; no new dev-dependency.)
        let root = temp_repo("app-resolution-parity");
        fs::create_dir_all(root.join("apps/zeta")).unwrap();
        fs::create_dir_all(root.join("apps/alpha")).unwrap();
        fs::create_dir_all(root.join("apps/.hidden")).unwrap();

        let run = Run {
            start: OsCommand {
                default: Some("npx nx serve {main_app}".into()),
                ..Default::default()
            },
            app_resolution: Some(AppResolution {
                placeholder: "main_app".into(),
                scan_dir: "apps".into(),
                strategy: "first_alphabetical".into(),
            }),
            ..Default::default()
        };
        let cmd = resolve_run_command(&root, &run).unwrap();
        assert_eq!(cmd, "npx nx serve \"alpha\"");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn main_app_falls_back_to_literal_app() {
        let root = temp_repo("mainapp-fallback");
        assert_eq!(
            resolve_run_command(&root, &nx_run()).as_deref(),
            Some(r#"npx nx serve "app""#)
        );
        // No app_resolution → untouched. No start command → None.
        let plain = Run {
            start: OsCommand {
                default: Some("npm start".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(resolve_run_command(&root, &plain).as_deref(), Some("npm start"));
        assert_eq!(resolve_run_command(&root, &Run::default()), None);
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
        // v2 data-driven fields: spring is editable, no per-type restart delay.
        assert!(repo.config_editable);
        assert_eq!(repo.restart_delay_ms, None);
        // current_branch / danger_flags are NOT detection's job.
        assert_eq!(repo.current_branch, None);
        assert!(repo.danger_flags.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn build_repo_info_runs_java_version_enricher() {
        // A bare def whose only enrichment is java_version proves the registry
        // loop actually dispatches the enricher (not just the spring fixture).
        let root = temp_repo("java-enricher");
        write(
            &root,
            "pom.xml",
            "<project><properties><java.version>17</java.version></properties></project>",
        );
        let def = RepoTypeDef {
            type_id: "maven-lib".to_string(),
            enrich: vec!["java_version".to_string()],
            ..Default::default()
        };
        let repo = build_repo_info("lib", &root, &def);
        assert_eq!(repo.java_version.as_deref(), Some("17"));

        // Without the enricher declared, the field stays empty even with a pom.
        let bare = RepoTypeDef {
            type_id: "maven-lib".to_string(),
            ..Default::default()
        };
        assert_eq!(build_repo_info("lib", &root, &bare).java_version, None);
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
        // v2 data-driven fields: docker-infra carries its restart delay and is
        // not editable.
        assert_eq!(repo.restart_delay_ms, Some(2000));
        assert!(!repo.config_editable);
        let _ = fs::remove_dir_all(root);
    }
}

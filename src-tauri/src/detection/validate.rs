//! Validation of loaded repo-type definitions. Unlike v1 (which silently
//! dropped broken YAML), v2 surfaces precise errors: wrong schema version,
//! unknown writer/enricher/app-resolution strategy/UI action, invalid regex.

use crate::config::writers::writer_exists;
use crate::detection::enrich::enricher_exists;
use crate::domain::repo_type::RepoTypeDef;

// Only strategies that `builder::resolve_app` actually dispatches. Validation
// must REJECT a `from_workspace_file` (or any other) strategy until its
// behavior is implemented — otherwise a YAML would pass validation then
// silently fall through to `first_alphabetical`. Re-add a name here the day
// the matching dispatch arm lands in `resolve_app`.
const KNOWN_STRATEGIES: &[&str] = &["first_alphabetical", "single_dir"];

/// A single validation problem, tied to the offending type id.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidationError {
    pub type_id: String,
    pub message: String,
}

/// Validate one definition. Returns all problems found (does not short-circuit).
pub fn validate_def(def: &RepoTypeDef) -> Vec<ValidationError> {
    let mut errors = Vec::new();
    let err = |msg: String| ValidationError {
        type_id: def.type_id.clone(),
        message: msg,
    };

    if def.schema_version != 2 {
        errors.push(err(format!(
            "schema_version must be 2, got {}",
            def.schema_version
        )));
    }
    if def.type_id.is_empty() {
        errors.push(err("missing `type`".to_string()));
    }
    if !writer_exists(&def.config.writer) {
        errors.push(err(format!("unknown config writer '{}'", def.config.writer)));
    }
    for name in &def.enrich {
        if !enricher_exists(name) {
            errors.push(err(format!("unknown enricher '{name}'")));
        }
    }
    if let Some(ar) = &def.run.app_resolution {
        if !KNOWN_STRATEGIES.contains(&ar.strategy.as_str()) {
            errors.push(err(format!(
                "unknown app_resolution strategy '{}'",
                ar.strategy
            )));
        }
    }
    for re in def
        .logs
        .ports
        .iter()
        .chain(def.logs.ready.iter())
        .chain(def.logs.error.iter())
    {
        if let Err(e) = regex::Regex::new(re) {
            errors.push(err(format!("invalid regex '{re}': {e}")));
        }
    }
    errors
}

/// Validate a whole set; returns the flattened error list.
pub fn validate_all(defs: &[RepoTypeDef]) -> Vec<ValidationError> {
    defs.iter().flat_map(validate_def).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::repo_type::RepoTypeDef;

    fn base() -> RepoTypeDef {
        RepoTypeDef {
            schema_version: 2,
            type_id: "x".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn rejects_wrong_schema_version() {
        let mut def = base();
        def.schema_version = 1;
        let errs = validate_def(&def);
        assert!(errs.iter().any(|e| e.message.contains("schema_version")));
    }

    #[test]
    fn rejects_unknown_writer() {
        let mut def = base();
        def.config.writer = "toml".to_string();
        let errs = validate_def(&def);
        assert!(errs.iter().any(|e| e.message.contains("unknown config writer")));
    }

    #[test]
    fn rejects_unknown_enricher() {
        let mut def = base();
        def.enrich = vec!["bogus".to_string()];
        let errs = validate_def(&def);
        assert!(errs.iter().any(|e| e.message.contains("unknown enricher")));
    }

    #[test]
    fn rejects_unknown_strategy() {
        let mut def = base();
        def.run.app_resolution = Some(crate::domain::repo_type::AppResolution {
            placeholder: "x".into(),
            scan_dir: "apps".into(),
            strategy: "weird".into(),
        });
        let errs = validate_def(&def);
        assert!(errs.iter().any(|e| e.message.contains("app_resolution strategy")));
    }

    #[test]
    fn rejects_invalid_regex() {
        let mut def = base();
        def.logs.ports = vec!["(".to_string()];
        let errs = validate_def(&def);
        assert!(errs.iter().any(|e| e.message.contains("invalid regex")));
    }

    #[test]
    fn accepts_clean_default() {
        // writer "raw" is known; no enrich/strategy.
        assert!(validate_def(&base()).is_empty());
    }
}

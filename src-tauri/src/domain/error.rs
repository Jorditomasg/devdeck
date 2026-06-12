//! Typed error model for the Rust core.
//!
//! Replaces v1's exception hierarchy (`domain/exceptions.py`,
//! inventory-backend.md §5) which was rarely raised — v1 overwhelmingly
//! swallowed errors and returned `(bool, str)` tuples. In v2 every fallible
//! library path returns `DomainResult<T>`; the `commands/` layer wraps this
//! into its IPC-serializable `AppError { kind, message }`
//! (architecture-v2.md §3.1) via [`DomainError::kind`].

use thiserror::Error;

/// Convenience alias used across `config/` and `detection/`.
pub type DomainResult<T> = Result<T, DomainError>;

/// All error categories produced by the domain/config/detection layers.
#[derive(Debug, Error)]
pub enum DomainError {
    /// Configuration file / schema problem (v1 `ConfigurationError`).
    #[error("configuration error: {0}")]
    Configuration(String),

    /// A repository could not be analyzed/classified
    /// (v1 `RepositoryDetectionError`).
    #[error("repository detection error: {0}")]
    Detection(String),

    /// Filesystem failure, annotated with the offending path.
    #[error("I/O error at '{path}': {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },

    /// A YAML document failed to parse (repo-type defs, Spring configs).
    #[error("YAML parse error in '{path}': {message}")]
    YamlParse { path: String, message: String },

    /// A JSON document failed to parse (app config, profiles).
    #[error("JSON parse error in '{path}': {message}")]
    JsonParse { path: String, message: String },

    /// v1 → v2 data migration failure (architecture-v2.md §6).
    #[error("migration error: {0}")]
    Migration(String),

    /// The OS did not expose a standard config/data directory.
    #[error("no OS {0} directory available")]
    NoOsDirectory(&'static str),
}

impl DomainError {
    /// Stable machine-readable kind, used by the `commands/` layer to build
    /// the `{ kind, message }` IPC error payload and by the frontend to map
    /// errors to i18n keys.
    pub fn kind(&self) -> &'static str {
        match self {
            DomainError::Configuration(_) => "configuration",
            DomainError::Detection(_) => "detection",
            DomainError::Io { .. } => "io",
            DomainError::YamlParse { .. } => "yaml_parse",
            DomainError::JsonParse { .. } => "json_parse",
            DomainError::Migration(_) => "migration",
            DomainError::NoOsDirectory(_) => "no_os_directory",
        }
    }

    /// Helper to wrap an `std::io::Error` with its path context.
    pub fn io(path: impl Into<String>, source: std::io::Error) -> Self {
        DomainError::Io {
            path: path.into(),
            source,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_is_stable() {
        assert_eq!(DomainError::Configuration("x".into()).kind(), "configuration");
        assert_eq!(DomainError::Detection("x".into()).kind(), "detection");
        assert_eq!(
            DomainError::io("/tmp/x", std::io::Error::new(std::io::ErrorKind::Other, "boom"))
                .kind(),
            "io"
        );
        assert_eq!(DomainError::Migration("x".into()).kind(), "migration");
    }

    #[test]
    fn display_includes_path() {
        let err = DomainError::YamlParse {
            path: "a.yml".into(),
            message: "bad".into(),
        };
        assert!(err.to_string().contains("a.yml"));
    }
}

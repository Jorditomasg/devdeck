//! Per-line ready/error/port state machine — the exact v1 semantics from
//! inventory-backend.md §21.2 (gui/repo_card/_git.py + _actions.py):
//!
//! - `starting` is set at spawn. If the repo type has NO `ready_pattern`,
//!   the service jumps straight to `running`.
//! - Each streamed line is evaluated in this order:
//!   1. **Port detection** — skipped once a port is known; tries the repo's
//!      `port_patterns`, else the fallback list; case-insensitive search;
//!      `group(1)` parsed as the port (v1 checked the port BEFORE the status
//!      transition for every line).
//!   2. **Status transition** — ONLY while `starting`: `error_pattern` match
//!      ⇒ `error` (checked FIRST, short-circuits), else `ready_pattern`
//!      match ⇒ `running`. After leaving `starting`, patterns are never
//!      evaluated again.
//! - On process exit (`finalize`): `stopped` if the user stopped it manually
//!   or it had reached `running`; `error` if it died while still `starting`
//!   (or had already errored). Installs always finalize to `stopped` unless
//!   manually stopped semantics say otherwise (v1 §17.1 marks stopped even
//!   on non-zero exit codes — the exit code is reported in the log line).
//!
//! Divergence note (lenient regex compile): v1 compiled patterns lazily per
//! line inside the reader thread; an invalid pattern would blow up that
//! thread. v2 compiles once at spawn and SKIPS invalid patterns with a
//! `log::warn`, treating a broken `ready_pattern` as absent.

use std::borrow::Cow;
use std::sync::OnceLock;

use regex::Regex;

use super::constants::{ANSI_ESCAPE_PATTERN, FALLBACK_PORT_PATTERNS};
use crate::events::ServiceStatus;

/// Strip ANSI escape sequences, using the byte-identical v1 regex
/// (gui/repo_card/_actions.py:13).
pub fn strip_ansi(line: &str) -> Cow<'_, str> {
    static ANSI_RE: OnceLock<Regex> = OnceLock::new();
    let re = ANSI_RE.get_or_init(|| {
        // Static, test-covered pattern — a compile failure is a programmer
        // error caught by the unit tests, never a runtime input.
        Regex::new(ANSI_ESCAPE_PATTERN).expect("static ANSI regex must compile")
    });
    re.replace_all(line, "")
}

/// Effects of analyzing one log line.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct LineEffects {
    /// `Some(new_status)` when this line caused a transition.
    pub status_changed: Option<ServiceStatus>,
    /// `Some(port)` when this line yielded the (first) detected port.
    pub port_detected: Option<u16>,
}

/// Compiled per-service regex state machine. Pure and synchronous —
/// feed it lines, read back transitions. One instance per supervised run.
pub struct LineAnalyzer {
    ready: Option<Regex>,
    error: Option<Regex>,
    ports: Vec<Regex>,
    status: ServiceStatus,
    port: Option<u16>,
}

impl LineAnalyzer {
    /// Build the analyzer for a long-lived service.
    ///
    /// `known_port` (static `server_port`) suppresses log-based port
    /// detection entirely, matching v1 (§21.2 "skipped if server_port
    /// already known"). Empty `port_patterns` falls back to
    /// [`FALLBACK_PORT_PATTERNS`].
    pub fn for_service(
        ready_pattern: Option<&str>,
        error_pattern: Option<&str>,
        port_patterns: &[String],
        known_port: Option<u16>,
    ) -> Self {
        let ready = compile_lenient(ready_pattern, false);
        let error = compile_lenient(error_pattern, false);

        let pattern_sources: Vec<&str> = if port_patterns.is_empty() {
            FALLBACK_PORT_PATTERNS.to_vec()
        } else {
            port_patterns.iter().map(String::as_str).collect()
        };
        let ports = pattern_sources
            .iter()
            .filter_map(|p| compile_lenient(Some(p), true))
            .collect();

        // No ready_pattern ⇒ jump straight to running (§21.2).
        let status = if ready.is_some() {
            ServiceStatus::Starting
        } else {
            ServiceStatus::Running
        };

        Self {
            ready,
            error,
            ports,
            status,
            port: known_port,
        }
    }

    /// Build the analyzer for an install run: no patterns, distinct
    /// `installing` status (v2 addition — v1 reused `'starting'`, §17.1).
    pub fn for_install() -> Self {
        Self {
            ready: None,
            error: None,
            ports: Vec::new(),
            status: ServiceStatus::Installing,
            port: None,
        }
    }

    pub fn status(&self) -> ServiceStatus {
        self.status
    }

    pub fn port(&self) -> Option<u16> {
        self.port
    }

    /// Analyze one (already ANSI-stripped, trimmed) log line.
    pub fn analyze(&mut self, line: &str) -> LineEffects {
        let mut effects = LineEffects::default();

        // 1. Port detection — first matching pattern wins, then never again.
        if self.port.is_none() {
            for re in &self.ports {
                if let Some(caps) = re.captures(line) {
                    if let Some(m) = caps.get(1) {
                        if let Ok(port) = m.as_str().parse::<u16>() {
                            self.port = Some(port);
                            effects.port_detected = Some(port);
                            break;
                        }
                    }
                }
            }
        }

        // 2. Status transitions — ONLY while starting; error short-circuits.
        if self.status == ServiceStatus::Starting {
            if let Some(error) = &self.error {
                if error.is_match(line) {
                    self.status = ServiceStatus::Error;
                    effects.status_changed = Some(ServiceStatus::Error);
                    return effects;
                }
            }
            if let Some(ready) = &self.ready {
                if ready.is_match(line) {
                    self.status = ServiceStatus::Running;
                    effects.status_changed = Some(ServiceStatus::Running);
                }
            }
        }

        effects
    }

    /// Decide the final status after process exit (§21.2 / §17.1):
    /// manual stop ⇒ `stopped`; died while `starting` ⇒ `error`; already
    /// `error` stays `error`; `running` / `installing` ⇒ `stopped`.
    pub fn finalize(&mut self, manually_stopped: bool) -> ServiceStatus {
        let final_status = if manually_stopped {
            ServiceStatus::Stopped
        } else {
            match self.status {
                ServiceStatus::Starting | ServiceStatus::Error => ServiceStatus::Error,
                _ => ServiceStatus::Stopped,
            }
        };
        self.status = final_status;
        final_status
    }
}

/// Compile a regex, optionally case-insensitive (port patterns use
/// `re.IGNORECASE` in v1, ready/error patterns do not — §21.2).
/// Invalid patterns are skipped with a warning (see module docs).
fn compile_lenient(pattern: Option<&str>, case_insensitive: bool) -> Option<Regex> {
    let pattern = pattern?;
    if pattern.is_empty() {
        return None;
    }
    let source = if case_insensitive {
        format!("(?i){pattern}")
    } else {
        pattern.to_owned()
    };
    match Regex::new(&source) {
        Ok(re) => Some(re),
        Err(err) => {
            log::warn!("skipping invalid pattern '{pattern}': {err}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spring_analyzer() -> LineAnalyzer {
        // Real shipped spring-boot.yml patterns (inventory-backend.md §20).
        LineAnalyzer::for_service(
            Some(r"Started \w+ in"),
            Some(r"Application run failed"),
            &[
                r"Tomcat (?:started on|initialized with) port.*?(\d+)".to_owned(),
                r"http://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])[:\s]+(\d+)".to_owned(),
            ],
            None,
        )
    }

    #[test]
    fn starts_in_starting_when_ready_pattern_present() {
        let analyzer = spring_analyzer();
        assert_eq!(analyzer.status(), ServiceStatus::Starting);
    }

    #[test]
    fn no_ready_pattern_jumps_straight_to_running() {
        let analyzer = LineAnalyzer::for_service(None, None, &[], None);
        assert_eq!(analyzer.status(), ServiceStatus::Running);
    }

    #[test]
    fn ready_match_transitions_to_running() {
        let mut analyzer = spring_analyzer();
        let fx = analyzer.analyze("2026-06-10 INFO Started DemoApplication in 3.2 seconds");
        assert_eq!(fx.status_changed, Some(ServiceStatus::Running));
        assert_eq!(analyzer.status(), ServiceStatus::Running);
    }

    #[test]
    fn error_match_transitions_to_error() {
        let mut analyzer = spring_analyzer();
        let fx = analyzer.analyze("ERROR o.s.boot.SpringApplication - Application run failed");
        assert_eq!(fx.status_changed, Some(ServiceStatus::Error));
        assert_eq!(analyzer.status(), ServiceStatus::Error);
    }

    #[test]
    fn error_takes_precedence_and_short_circuits() {
        // A line matching BOTH patterns must yield error (v1 checks error first).
        let mut analyzer = LineAnalyzer::for_service(
            Some("BOOM"),
            Some("BOOM"),
            &[],
            None,
        );
        let fx = analyzer.analyze("BOOM");
        assert_eq!(fx.status_changed, Some(ServiceStatus::Error));
    }

    #[test]
    fn no_transitions_after_leaving_starting() {
        let mut analyzer = spring_analyzer();
        analyzer.analyze("Started DemoApplication in 3.2 seconds");
        assert_eq!(analyzer.status(), ServiceStatus::Running);
        // An error line AFTER running must not flip the status (v1: patterns
        // only evaluated while starting).
        let fx = analyzer.analyze("Application run failed");
        assert_eq!(fx.status_changed, None);
        assert_eq!(analyzer.status(), ServiceStatus::Running);
    }

    #[test]
    fn port_extracted_from_repo_pattern_group_one() {
        let mut analyzer = spring_analyzer();
        let fx = analyzer.analyze("Tomcat started on port(s): 8080 (http)");
        assert_eq!(fx.port_detected, Some(8080));
        assert_eq!(analyzer.port(), Some(8080));
    }

    #[test]
    fn port_detection_is_case_insensitive() {
        let mut analyzer = spring_analyzer();
        let fx = analyzer.analyze("TOMCAT STARTED ON PORT(S): 9090");
        assert_eq!(fx.port_detected, Some(9090));
    }

    #[test]
    fn port_detected_only_once() {
        let mut analyzer = spring_analyzer();
        analyzer.analyze("Tomcat started on port(s): 8080");
        let fx = analyzer.analyze("Tomcat started on port(s): 9999");
        assert_eq!(fx.port_detected, None);
        assert_eq!(analyzer.port(), Some(8080));
    }

    #[test]
    fn known_port_suppresses_detection() {
        let mut analyzer = LineAnalyzer::for_service(
            Some("READY"),
            None,
            &[r"port\s+(\d+)".to_owned()],
            Some(8443),
        );
        let fx = analyzer.analyze("listening on port 1234");
        assert_eq!(fx.port_detected, None);
        assert_eq!(analyzer.port(), Some(8443));
    }

    #[test]
    fn fallback_port_patterns_used_when_repo_declares_none() {
        let mut analyzer = LineAnalyzer::for_service(Some("READY"), None, &[], None);
        let fx = analyzer.analyze("Server available at http://localhost:4200");
        assert_eq!(fx.port_detected, Some(4200));
    }

    #[test]
    fn port_and_ready_on_same_line_reports_both() {
        let mut analyzer = LineAnalyzer::for_service(
            Some("Listening"),
            None,
            &[r"Listening on.*?(\d+)".to_owned()],
            None,
        );
        let fx = analyzer.analyze("Listening on port 3000");
        assert_eq!(fx.port_detected, Some(3000));
        assert_eq!(fx.status_changed, Some(ServiceStatus::Running));
    }

    #[test]
    fn invalid_patterns_are_skipped_without_panicking() {
        let mut analyzer = LineAnalyzer::for_service(
            Some("(unclosed"),
            Some("[bad"),
            &["(also(bad".to_owned()],
            None,
        );
        // Broken ready pattern is treated as absent ⇒ initial running.
        assert_eq!(analyzer.status(), ServiceStatus::Running);
        let fx = analyzer.analyze("anything");
        assert_eq!(fx, LineEffects::default());
    }

    #[test]
    fn finalize_manual_stop_wins() {
        let mut analyzer = spring_analyzer(); // still starting
        assert_eq!(analyzer.finalize(true), ServiceStatus::Stopped);
    }

    #[test]
    fn finalize_death_while_starting_is_error() {
        let mut analyzer = spring_analyzer();
        assert_eq!(analyzer.finalize(false), ServiceStatus::Error);
    }

    #[test]
    fn finalize_after_running_is_stopped() {
        let mut analyzer = spring_analyzer();
        analyzer.analyze("Started DemoApplication in 1 seconds");
        assert_eq!(analyzer.finalize(false), ServiceStatus::Stopped);
    }

    #[test]
    fn finalize_keeps_error() {
        let mut analyzer = spring_analyzer();
        analyzer.analyze("Application run failed");
        assert_eq!(analyzer.finalize(false), ServiceStatus::Error);
    }

    #[test]
    fn finalize_install_is_stopped() {
        let mut analyzer = LineAnalyzer::for_install();
        assert_eq!(analyzer.status(), ServiceStatus::Installing);
        assert_eq!(analyzer.finalize(false), ServiceStatus::Stopped);
    }

    #[test]
    fn strip_ansi_removes_color_codes() {
        let colored = "\x1b[32mBUILD SUCCESS\x1b[0m plain";
        assert_eq!(strip_ansi(colored), "BUILD SUCCESS plain");
    }

    #[test]
    fn strip_ansi_leaves_plain_text_untouched() {
        assert_eq!(strip_ansi("no escapes here"), "no escapes here");
    }
}

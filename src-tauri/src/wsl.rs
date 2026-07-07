//! WSL path detection and `wsl.exe` invocation shared by git, process
//! supervision and docker (design doc 2026-07-07-wsl-service-execution-design.md).
//! A repo addressed through a WSL UNC share (`\\wsl.localhost\<distro>\...`
//! or legacy `\\wsl$\...`) runs its commands INSIDE the distro.

use std::collections::HashMap;
use std::path::Path;

use tokio::process::Command;

/// A repo living inside a WSL distro, addressed from Windows via its UNC
/// share. `linux_path` is absolute inside the distro (`/home/...`).
#[cfg_attr(not(windows), allow(dead_code))]
pub struct WslPath {
    pub distro: String,
    pub linux_path: String,
}

/// [`parse_wsl_path`] on Windows; always `None` elsewhere — Linux builds
/// never reroute (a Unix path can't be a WSL UNC share anyway).
pub fn wsl_path_for(path: &Path) -> Option<WslPath> {
    #[cfg(windows)]
    return parse_wsl_path(path);
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

/// Parse `\\wsl.localhost\<distro>\<rest>` (or legacy `\\wsl$\...`, or the
/// verbatim `\\?\UNC\...` form) into distro + absolute Linux path. `None` for
/// anything else — drive letters, other UNC shares, Unix paths.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_wsl_path(path: &Path) -> Option<WslPath> {
    let s = path.to_str()?.replace('/', "\\");
    // Try the verbatim prefix FIRST — `\\?\UNC\...` also starts with `\\`.
    let rest = s.strip_prefix(r"\\?\UNC\").or_else(|| s.strip_prefix(r"\\"))?;
    let mut parts = rest.splitn(3, '\\');
    let server = parts.next()?;
    if !server.eq_ignore_ascii_case("wsl.localhost") && !server.eq_ignore_ascii_case("wsl$") {
        return None;
    }
    let distro = parts.next()?;
    let tail = parts.next()?;
    if distro.is_empty() || tail.trim_end_matches('\\').is_empty() {
        return None; // distro root is not a repo
    }
    Some(WslPath {
        distro: distro.to_string(),
        linux_path: format!("/{}", tail.trim_end_matches('\\').replace('\\', "/")),
    })
}

/// The base `wsl.exe -d <distro>` invocation. WSL_UTF8: wsl.exe's OWN
/// diagnostics (bad distro, --cd failure) are UTF-16 by default; force
/// UTF-8 so they survive `from_utf8_lossy` (moved from git/exec.rs).
pub fn base_command(distro: &str) -> Command {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["-d", distro]).env("WSL_UTF8", "1");
    cmd
}

/// POSIX single-quote escaping: `'` → `'\''`.
fn sq_escape(s: &str) -> String {
    s.replace('\'', r"'\''")
}

/// The bash script for an in-distro run: profile env as `export` entries
/// (env set on the Windows wsl.exe process does NOT cross into Linux),
/// optional Linux-PGID marker, then the user command. NOT `exec`-prefixed:
/// compound commands (`a && b`) must keep bash as the setsid group leader,
/// and `$$` already identifies the whole tree.
pub fn shell_script(command: &str, env: &HashMap<String, String>, emit_pid: bool) -> String {
    let mut script = String::new();
    let mut keys: Vec<&String> = env.keys().collect();
    keys.sort(); // deterministic output (HashMap order is random)
    for k in keys {
        script.push_str(&format!("export '{}={}'; ", sq_escape(k), sq_escape(&env[k])));
    }
    if emit_pid {
        script.push_str("echo \"__DEVDECK_PID__$$\"; ");
    }
    script.push_str(command);
    script
}

/// Parse the PGID marker emitted as the run's first stdout line. Anchored:
/// the WHOLE (already-trimmed) line must be marker + digits.
pub fn parse_pid_line(line: &str) -> Option<u32> {
    line.strip_prefix("__DEVDECK_PID__")?.parse().ok()
}

/// The two stderr lines `bash -i` emits without a tty. Filtered from WSL
/// run logs (design doc §2). ponytail: exact-prefix match — a service
/// legitimately printing these exact lines loses them; acceptable.
pub fn is_bash_noise(line: &str) -> bool {
    line.starts_with("bash: cannot set terminal process group")
        || line == "bash: no job control in this shell"
}

/// `kill` invocation for the whole Linux process group (negative pgid),
/// run via `/bin/sh -c` inside the distro.
pub fn kill_group_script(pgid: u32, force: bool) -> String {
    let sig = if force { "KILL" } else { "TERM" };
    format!("kill -{sig} -- -{pgid}")
}

/// Spawn a service/install command inside the distro: `setsid` makes bash
/// its own session/group leader (the mirror of the Unix `process_group(0)`
/// spawn), `bash -ilc` loads the FULL .bashrc — Ubuntu's interactivity
/// guard returns before nvm init in non-interactive shells, so `-i` is
/// required, not optional.
pub fn exec_in_distro(wsl: &WslPath, script: &str) -> Command {
    let mut cmd = base_command(&wsl.distro);
    cmd.args(["--cd", &wsl.linux_path, "--exec", "setsid", "bash", "-ilc", script]);
    cmd
}

/// Run a program directly inside the distro (no shell, no PID protocol) —
/// short-lived commands like docker compose queries, mirroring git routing.
pub fn exec_plain(wsl: &WslPath, program: &str) -> Command {
    let mut cmd = base_command(&wsl.distro);
    cmd.args(["--cd", &wsl.linux_path, "--exec", program]);
    cmd
}

#[cfg(test)]
mod tests {
    use super::{
        parse_wsl_path, shell_script, parse_pid_line, is_bash_noise, kill_group_script,
        exec_in_distro, exec_plain, WslPath,
    };
    use std::collections::HashMap;
    use std::path::Path;
    use tokio::process::Command;

    /// `(distro, linux_path)` or `None` — thin harness over the parser.
    fn parse(s: &str) -> Option<(String, String)> {
        parse_wsl_path(Path::new(s)).map(|w| (w.distro, w.linux_path))
    }

    #[test]
    fn parses_wsl_localhost_share() {
        assert_eq!(
            parse(r"\\wsl.localhost\Ubuntu\home\jordi\api"),
            Some(("Ubuntu".into(), "/home/jordi/api".into()))
        );
    }

    #[test]
    fn parses_legacy_wsl_dollar_share() {
        assert_eq!(
            parse(r"\\wsl$\Debian\srv\app"),
            Some(("Debian".into(), "/srv/app".into()))
        );
    }

    #[test]
    fn parses_verbatim_unc_form() {
        // std::fs::canonicalize yields this form on Windows.
        assert_eq!(
            parse(r"\\?\UNC\wsl.localhost\Ubuntu\home\jordi\api"),
            Some(("Ubuntu".into(), "/home/jordi/api".into()))
        );
    }

    #[test]
    fn normalizes_forward_slashes_and_trailing_separator() {
        assert_eq!(
            parse(r"//wsl.localhost/Ubuntu/home/jordi/api/"),
            Some(("Ubuntu".into(), "/home/jordi/api".into()))
        );
    }

    #[test]
    fn server_match_is_case_insensitive() {
        assert_eq!(
            parse(r"\\WSL.LOCALHOST\Ubuntu\home\x"),
            Some(("Ubuntu".into(), "/home/x".into()))
        );
    }

    #[test]
    fn rejects_non_wsl_paths() {
        assert_eq!(parse(r"C:\proyectos\api"), None); // drive letter
        assert_eq!(parse(r"\\fileserver\share\repo"), None); // other UNC
        assert_eq!(parse(r"\\?\C:\proyectos\api"), None); // verbatim drive
        assert_eq!(parse("/home/jordi/api"), None); // unix path
        assert_eq!(parse(r"\\wsl.localhost\Ubuntu"), None); // distro root
        assert_eq!(parse(r"\\wsl.localhost\Ubuntu\"), None); // distro root
        assert_eq!(parse(r"\\wsl.localhost\\home\x"), None); // empty distro
    }

    fn args_of(cmd: &Command) -> Vec<String> {
        cmd.as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn shell_script_exports_env_emits_pid_then_runs_command() {
        let mut env = HashMap::new();
        env.insert("SPRING_PROFILES_ACTIVE".to_string(), "dev".to_string());
        assert_eq!(
            shell_script("npm start", &env, true),
            "export 'SPRING_PROFILES_ACTIVE=dev'; echo \"__DEVDECK_PID__$$\"; npm start"
        );
    }

    #[test]
    fn shell_script_sorts_env_keys_deterministically() {
        let mut env = HashMap::new();
        env.insert("B".to_string(), "2".to_string());
        env.insert("A".to_string(), "1".to_string());
        assert_eq!(
            shell_script("run", &env, false),
            "export 'A=1'; export 'B=2'; run"
        );
    }

    #[test]
    fn shell_script_escapes_single_quotes_in_values() {
        let mut env = HashMap::new();
        env.insert("JAVA_OPTS".to_string(), "-Dname='x y'".to_string());
        assert_eq!(
            shell_script("mvn spring-boot:run", &env, false),
            r"export 'JAVA_OPTS=-Dname='\''x y'\'''; mvn spring-boot:run"
        );
    }

    #[test]
    fn shell_script_without_env_or_pid_is_the_bare_command() {
        assert_eq!(
            shell_script("docker-compose down", &HashMap::new(), false),
            "docker-compose down"
        );
    }

    #[test]
    fn pid_line_parses_marker_and_rejects_everything_else() {
        assert_eq!(parse_pid_line("__DEVDECK_PID__4242"), Some(4242));
        assert_eq!(parse_pid_line("__DEVDECK_PID__"), None);
        assert_eq!(parse_pid_line("__DEVDECK_PID__x1"), None);
        assert_eq!(parse_pid_line("npm start"), None);
        assert_eq!(parse_pid_line("x __DEVDECK_PID__1"), None); // prefix only
    }

    #[test]
    fn bash_noise_filter_matches_exactly_the_two_no_tty_lines() {
        assert!(is_bash_noise(
            "bash: cannot set terminal process group (-1): Inappropriate ioctl for device"
        ));
        assert!(is_bash_noise("bash: no job control in this shell"));
        assert!(!is_bash_noise("bash: npm: command not found")); // real error — must pass
        assert!(!is_bash_noise("Compiled successfully."));
    }

    #[test]
    fn kill_group_script_signals_the_negative_pgid() {
        assert_eq!(kill_group_script(4242, false), "kill -TERM -- -4242");
        assert_eq!(kill_group_script(4242, true), "kill -KILL -- -4242");
    }

    #[test]
    fn exec_in_distro_builds_setsid_login_interactive_bash() {
        let w = WslPath { distro: "Ubuntu".into(), linux_path: "/home/j/app".into() };
        let cmd = exec_in_distro(&w, "echo hi");
        assert_eq!(cmd.as_std().get_program().to_string_lossy(), "wsl.exe");
        assert_eq!(
            args_of(&cmd),
            ["-d", "Ubuntu", "--cd", "/home/j/app", "--exec", "setsid", "bash", "-ilc", "echo hi"]
        );
    }

    #[test]
    fn exec_plain_builds_direct_exec_without_shell() {
        let w = WslPath { distro: "Ubuntu".into(), linux_path: "/srv/stack".into() };
        let cmd = exec_plain(&w, "docker");
        assert_eq!(
            args_of(&cmd),
            ["-d", "Ubuntu", "--cd", "/srv/stack", "--exec", "docker"]
        );
    }
}

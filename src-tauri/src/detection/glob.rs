//! Minimal `fnmatch`-style glob matching (Python `fnmatch` parity).
//!
//! v1 matched env-file globs, detection heuristics and docker-compose file
//! names with Python's `fnmatch` (`project_analyzer.py`, inventory-backend.md
//! §6.5-§6.6). Supported syntax: `*` (any run), `?` (one char), `[seq]` /
//! `[!seq]` (character class with ranges). Python's `fnmatch.fnmatch`
//! `normcase`s both sides, making matching case-insensitive on Windows and
//! case-sensitive on POSIX — replicated here.
//!
//! Dependency-free on purpose: the `regex` crate is reserved for the
//! inventory-cited extraction patterns (profiles, pom.xml, Spring config),
//! which must be ported verbatim.

/// Python-`fnmatch.fnmatch` parity: case-insensitive on Windows
/// (`os.path.normcase` lowercases there), case-sensitive elsewhere.
pub fn fnmatch(name: &str, pattern: &str) -> bool {
    if cfg!(windows) {
        let name: Vec<char> = name.to_lowercase().chars().collect();
        let pattern: Vec<char> = pattern.to_lowercase().chars().collect();
        glob_match(&pattern, &name)
    } else {
        let name: Vec<char> = name.chars().collect();
        let pattern: Vec<char> = pattern.chars().collect();
        glob_match(&pattern, &name)
    }
}

/// Iterative glob matcher with single-star backtracking.
fn glob_match(pat: &[char], text: &[char]) -> bool {
    let mut p = 0usize; // position in pattern
    let mut t = 0usize; // position in text
    // Last `*` seen: (pattern index of the star, text index it currently
    // swallows up to). On mismatch we retry the star with one more char.
    let mut star: Option<(usize, usize)> = None;

    while t < text.len() {
        let mut advanced = false;
        if p < pat.len() {
            match pat[p] {
                '*' => {
                    star = Some((p, t));
                    p += 1;
                    continue;
                }
                '?' => {
                    p += 1;
                    t += 1;
                    advanced = true;
                }
                '[' => {
                    if let Some((matched, next_p)) = match_class(pat, p, text[t]) {
                        if matched {
                            p = next_p;
                            t += 1;
                            advanced = true;
                        }
                    } else if text[t] == '[' {
                        // Unterminated class → literal `[` (Python behavior).
                        p += 1;
                        t += 1;
                        advanced = true;
                    }
                }
                c => {
                    if c == text[t] {
                        p += 1;
                        t += 1;
                        advanced = true;
                    }
                }
            }
        }
        if !advanced {
            match star {
                Some((sp, st)) => {
                    // Let the star swallow one more character and retry.
                    p = sp + 1;
                    t = st + 1;
                    star = Some((sp, st + 1));
                }
                None => return false,
            }
        }
    }
    // Only trailing stars may remain unconsumed.
    pat[p..].iter().all(|&c| c == '*')
}

/// Match a `[...]` class starting at `pat[start] == '['` against `c`.
/// Returns `(matched, index after ']')`, or `None` when the class is
/// unterminated (caller treats `[` as a literal).
fn match_class(pat: &[char], start: usize, c: char) -> Option<(bool, usize)> {
    let mut i = start + 1;
    let negated = if i < pat.len() && (pat[i] == '!' || pat[i] == '^') {
        i += 1;
        true
    } else {
        false
    };
    let mut matched = false;
    let mut first = true;
    while i < pat.len() {
        if pat[i] == ']' && !first {
            return Some((matched != negated, i + 1));
        }
        first = false;
        if i + 2 < pat.len() && pat[i + 1] == '-' && pat[i + 2] != ']' {
            if pat[i] <= c && c <= pat[i + 2] {
                matched = true;
            }
            i += 3;
        } else {
            if pat[i] == c {
                matched = true;
            }
            i += 1;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_shipped_repo_type_globs() {
        // env_files.patterns / heuristics.must_match_patterns from §1.7.
        assert!(fnmatch("application.yml", "application*.yml"));
        assert!(fnmatch("application-dev.yml", "application*.yml"));
        assert!(fnmatch("application-pre.properties", "application*.properties"));
        assert!(!fnmatch("application.yml", "application*.yaml"));
        assert!(fnmatch("environment.ts", "environment*.ts"));
        assert!(fnmatch("environment.prod.ts", "environment*.ts"));
        assert!(fnmatch(".env", ".env*"));
        assert!(fnmatch(".env.local", ".env*"));
        assert!(fnmatch(".env.local", ".env.*"));
        assert!(!fnmatch("env.local", ".env*"));
        assert!(fnmatch("docker-compose.yml", "docker-compose*.yml"));
        assert!(fnmatch("docker-compose.override.yaml", "docker-compose*.yaml"));
        assert!(!fnmatch("compose.yml", "docker-compose*.yml"));
    }

    #[test]
    fn star_question_and_class_semantics() {
        assert!(fnmatch("abc", "*"));
        assert!(fnmatch("", "*"));
        assert!(!fnmatch("", "?"));
        assert!(fnmatch("a", "?"));
        assert!(fnmatch("abc", "a*c"));
        assert!(fnmatch("ac", "a*c"));
        assert!(!fnmatch("ab", "a*c"));
        assert!(fnmatch("a.txt", "a[.-]txt"));
        assert!(fnmatch("file5", "file[0-9]"));
        assert!(!fnmatch("filex", "file[0-9]"));
        assert!(fnmatch("filex", "file[!0-9]"));
        assert!(fnmatch("x*y", "x[*]y"));
    }

    #[test]
    fn double_star_backtracking() {
        assert!(fnmatch("application-dev-local.yml", "application*local*.yml"));
        assert!(!fnmatch("application-dev.yml", "application*local*.yml"));
    }

    #[cfg(windows)]
    #[test]
    fn case_insensitive_on_windows() {
        assert!(fnmatch("Application.YML", "application*.yml"));
    }

    #[cfg(not(windows))]
    #[test]
    fn case_sensitive_on_posix() {
        assert!(!fnmatch("Application.yml", "application*.yml"));
    }
}

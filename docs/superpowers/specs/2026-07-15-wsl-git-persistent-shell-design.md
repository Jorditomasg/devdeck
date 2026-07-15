# WSL Git — Persistent Shell for Reads — Design

**Date:** 2026-07-15
**Status:** Approved
**Problem:** For a repo on a WSL UNC share, EVERY git command spawns a fresh `wsl.exe -d <distro> --cd <path> --exec git ...` process (`git/exec.rs`). Each spawn crosses the Windows↔WSL2 VM boundary — a fixed ~150-400 ms interop cost (worse when the distro is cold and the VM must wake). Windows-native git pays ~5-20 ms, so the cost is invisible there but dominates on WSL. Opening the git/merge window fires many reads (`get_ordered_branches` alone is 3 serial crossings: `branch`, `branch -r`, `reflog`; the full window adds `get_current_branch`, `merge_in_progress`, `get_log`, per-commit files…). N serial crossings = the multi-second stall the user feels.

**Goal:** Bring WSL git READS to near-native latency with ZERO user setup (opening the app is enough — nothing to install inside the distro) and without regressing correctness, cancellation safety, or injection safety. Achieve it by keeping ONE persistent `bash` session alive per distro and streaming read commands to it, so only the first read pays the crossing. Mutating/long-running ops keep the current one-shot path untouched.

## Decisions (with rationale)

- **Persistent `bash` session per distro, NOT a custom daemon.** A shipped Linux binary (VSCode-server style) would need copying into the distro, versioning, arch-matching (x86_64/arm64), sync with the app, and cleanup. A `bash` session installs NOTHING — `wsl.exe` + `bash` are guaranteed present whenever a WSL repo exists. On the "zero-config + low error surface" axis, bash strictly beats a daemon. The persistent process also keeps the distro warm by construction, so first-access cold-start disappears for free.
- **Reads only through the session; mutations/long ops stay one-shot.** The high-frequency, short commands (status, branch, log, rev-parse, diff) are where per-spawn overhead dominates — route them through the session. Mutations and long ops (fetch, pull, merge, push, checkout, reset, clean) are rare and already expected to take time; their spawn overhead is irrelevant. Keeping them on the existing `wsl.exe --exec git` one-shot path preserves `kill_on_drop` cancellation AND the shell-free `--exec` guarantee for the commands that carry user-supplied refs into a mutation.
- **Read/mutation discriminator = the timeout tier.** `T_QUERY` (10s) and `T_FAST` (5s) are used EXCLUSIVELY by reads today; `T_BRANCH_OP`/`T_FETCH`/`T_FETCH_QUIET`/`T_LONG` by mutations/long ops. Routing on `timeout_secs ∈ {T_QUERY, T_FAST}` needs ZERO call-site changes across the ~59 `run_git` callers. Documented heuristic; apply MUST verify no mutating command uses `T_QUERY`/`T_FAST` before relying on it.
- **`git -C <path>` instead of `--cd`.** One session per distro serves ALL repos in that distro — no per-repo cwd state, no session-per-repo explosion. The badge poller sweeps every repo through the same session.
- **In-shell `timeout <secs>` per command.** Restores per-command cancellation without killing the shared shell: a wedged read dies alone (exit 124 → `GitError::Timeout`), the session survives. An OUTER `tokio::time::timeout` (a few seconds beyond the in-shell budget) guards against the shell itself wedging; if it fires, the session is killed and respawned.
- **One session per distro, serialized by a mutex.** Reads are near-native once warm, so serializing a burst of fast commands beats 3 concurrent slow spawns. `// ponytail: 1 session/distro serializes reads; add a pool of 3 (matching the badge semaphore) only if measured need.`
- **`bash --norc --noprofile`.** Reads need only system git on the default PATH (`/usr/bin/git`); skipping rc/profile is faster and deterministic. `// ponytail: a distro that exposes git ONLY via a custom .bashrc PATH would fail reads — not a known real setup; revisit if it ever appears.`

## 1. New module `src-tauri/src/git/session.rs`

The persistent-session pool. Public surface (all `pub(crate)`):

```
async fn run_query(wsl: &WslPath, args: &[&str], timeout_secs: u64) -> Result<GitOutput, GitError>
```

- Global registry: `static SESSIONS: Lazy<Mutex<HashMap<String /*distro*/, Arc<Session>>>>`. `run_query` looks up (or lazily creates) the `Arc<Session>` for `wsl.distro`, then calls `session.query(&wsl.linux_path, args, timeout_secs)`.
- `struct Session { child: tokio::Mutex<Option<Child>>, counter: AtomicU64 }`. The `Option<Child>` is `None` when dead; `query` (re)spawns on demand.
- Spawn: `crate::wsl::base_command(distro)` + `["--exec", "bash", "--norc", "--noprofile"]`, `stdin/stdout` piped, `stderr` null (combined into stdout — see framing), `CREATE_NO_WINDOW`, `kill_on_drop(true)`.
- `query` under the child mutex:
  1. Ensure a live child (spawn if `None`).
  2. `nonce = counter.fetch_add(1)`; build the framed command line (§2); write it + `\n` to stdin.
  3. Read stdout lines until the sentinel line; everything before = combined output; sentinel digits = exit code.
  4. Wrap steps 2-3 in `tokio::time::timeout(timeout_secs + GRACE)`. On outer timeout OR any IO error (broken pipe/EOF): drop the child (`None`) and — for IO errors only — respawn + retry ONCE; on outer timeout return `GitError::Timeout`.
  5. Map exit code → `GitOutput { success: code == 0, stdout: combined, stderr: String::new() }`; code `124` → `GitError::Timeout`.

## 2. Command framing (pure, unit-tested — TDD)

`build_query_line(linux_path, args, nonce, timeout_secs) -> String`:

```
timeout -k 2 <secs> git -C '<esc path>' '<esc arg1>' '<esc arg2>' … 2>&1; printf '\n__DEVDECK_END_<nonce>__%d\n' "$?"
```

- Every path/arg single-quote-escaped via `crate::wsl::sq_escape` (make it `pub(crate)`). Combined with the existing `is_option_like` guard at the public entry points, refs can never become flags or shell tokens.
- `2>&1`: stderr merged into stdout. Read callers consume only `stdout` + `success`; on failure `error_message()` already falls back to stdout when stderr is empty, so error text survives.
- Sentinel token `__DEVDECK_END_<nonce>__` uses a per-session monotonic counter. `// ponytail: counter-nonce; a collision needs git output to print this exact evolving token — accept.`

`parse_sentinel(line, nonce) -> Option<i32>`: exact match of the whole trimmed line against `__DEVDECK_END_<nonce>__` + digits → the exit code. (Pure, unit-tested — TDD.)

## 3. Integration in `git/exec.rs` `run_git`

Add a Windows-only read short-circuit at the TOP of `run_git`, before `git_command`:

```rust
#[cfg(windows)]
if let Some(wsl) = wsl_path_for(repo) {
    if timeout_secs == T_QUERY || timeout_secs == T_FAST {
        return crate::git::session::run_query(&wsl, args, timeout_secs).await;
    }
    // mutation/long op → falls through to the existing one-shot --exec path
}
```

`git_command`/`run_git`'s existing body is unchanged — mutations on WSL still route via `--exec` exactly as today; non-WSL repos are untouched.

## 4. What does NOT change

- No new IPC commands, no events, no frontend changes, no `commands.spec.ts`/`events.spec.ts` count changes.
- No config toggles — activation is automatic by path shape, like git/service routing.
- `git/exec.rs::run_git`'s one-shot path, `run_logged_op`, and every mutating op surface are byte-for-byte behaviorally identical.
- Non-Windows builds: `run_query` is never reached (`wsl_path_for` is `None`); `session.rs` is `#[cfg(windows)]`-gated to avoid dead-code warnings elsewhere.

## 5. Tasks

- [ ] **T1 (TDD):** `wsl::sq_escape` → `pub(crate)`. `git/session.rs`: `build_query_line` + `parse_sentinel` with `#[cfg(test)] mod tests` (escaping, `-C` path, timeout wrap, sentinel emit; sentinel exact-match, nonce mismatch, non-sentinel line, trailing digits). Red → green.
- [ ] **T2:** `Session` struct + global registry + `query` (spawn, mutex, framed write, read-until-sentinel, outer timeout, respawn-and-retry-once). `#[cfg(windows)]`.
- [ ] **T3:** `run_query` public entry (registry lookup / lazy create).
- [ ] **T4:** Wire `mod session;` in `git/mod.rs`; add the read short-circuit in `run_git`.
- [ ] **T5 (verify-before-relying):** Confirm no mutating command uses `T_QUERY`/`T_FAST` (grep the mutating ops). If any does, switch it to an explicit tier or exclude it.
- [ ] **T6:** `cargo test --manifest-path src-tauri/Cargo.toml` green (after `npm run build`). Non-Windows compile clean (no dead-code warnings). `npx madge --circular` unaffected (Rust-only change).

## 6. Expected result

Opening the git/merge window on a WSL repo: from ~3-4 serial crossings (~1-1.5 s, worse when cold) to ONE crossing on the first read, then near-native latency for every subsequent read for the app's lifetime. Badge polling of WSL repos drops from one `wsl.exe` spawn per repo per cycle to one framed write on the warm session.

/**
 * Workspace-feature timing & concurrency constants.
 *
 * Every value cites docs/migration/inventory-gui.md §28 ("Timing, debounce &
 * concurrency table" — documented performance constraints that must survive
 * the migration). Poll intervals (30 s badges / 15 s docker) intentionally do
 * NOT appear here: polling lives in Rust now (ipc-contract.md §3) and the
 * frontend only consumes events.
 */

/**
 * Profile dirty-check debounce — §28 `PROFILE_DEBOUNCE_MS` (300 ms is the
 * documented contract for change bursts; the invariant is "many triggers per
 * burst → one comparison").
 */
export const PROFILE_DEBOUNCE_MS = 300;

/** Stop→start gap of the GlobalPanel batch restart — §28 "Global restart delay". */
export const GLOBAL_RESTART_DELAY_MS = 3000;

/**
 * Stop→start gap when restarting a docker-compose card — §28 "Card restart
 * delay (docker)". Process repos restart through `restart_service`, which
 * applies the 300 ms process delay Rust-side (ipc-contract.md §2.3 #5).
 */
export const DOCKER_RESTART_DELAY_MS = 2000;

/**
 * "Pull all" runs strictly sequentially — §3 "sequential `git pull` of each
 * selected repo" (v1 global_panel.py:176-194).
 */
export const PULL_ALL_CONCURRENCY = 1;

/**
 * Branch apply / checkout fan-out cap — §28 `GIT_BADGE_SEMAPHORE_COUNT` (3):
 * v1 capped concurrent git subprocesses at 3 per kind.
 */
export const GIT_BATCH_CONCURRENCY = 3;

/**
 * "Install all" fan-out cap. v1 ran installs in unbounded parallel threads
 * (§3); v2 bounds them to the per-card action-pool width — §28 "Per-card
 * action pool ThreadPoolExecutor(3)".
 */
export const INSTALL_ALL_CONCURRENCY = 3;

/** Expand/collapse panel transition (task spec: smooth ~150 ms). */
export const EXPAND_ANIM_MS = 150;

/** Suffix marking an unsaved profile in the topbar combo — §26 `PROFILE_DIRTY_SUFFIX`. */
export const PROFILE_DIRTY_SUFFIX = ' *';

/** Max dirty files listed in the pull-blocked error message — §12 "up to 10 files". */
export const PULL_ERROR_MAX_FILES = 10;

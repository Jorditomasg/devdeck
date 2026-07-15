//! Per-service Windows Job Object — the tree-kill primitive that replaces
//! `taskkill /F /T` as PRIMARY (stop-orphan-processes design doc, decision
//! #462). Every Windows-spawned service child is assigned to its OWN fresh
//! Job Object right after `spawn()`, with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
//! set. This registers descendants at BIRTH instead of discovering them at
//! kill time (the taskkill PPID walk) — the direct Windows analog of the
//! existing Unix `process_group(0)` fix in [`super::manager::build_command`].
//!
//! Platform mapping:
//! - **Windows**: `CreateJobObjectW` → wrap in [`ServiceJob`] immediately
//!   (RAII, so any later `?` auto-closes the handle) → `SetInformationJobObject`
//!   with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` → `AssignProcessToJobObject`.
//!   [`ServiceJob::terminate`] calls `TerminateJobObject`, killing every
//!   process in the job (including detached/reparented grandchildren such as
//!   `mvnw.cmd` → `java.exe`) in one call. Dropping the last handle (normal
//!   exit OR app crash) makes the OS tear down any survivors via
//!   `KILL_ON_JOB_CLOSE` — the property that fixes the crash-orphan case.
//! - **Non-Windows**: a never-constructed stub so [`super::manager`] stays
//!   `cfg`-free at its call sites; `terminate()` is an inert `Ok(())`.
//!
//! Dependency note: extends the existing `windows` crate features already
//! used by `super::super::window`/tray code (0.61.x) — no new crate. See
//! `Cargo.toml` `[target.'cfg(windows)'.dependencies]` for the three added
//! feature flags (`Win32_System_JobObjects`, `Win32_System_Threading`,
//! `Win32_Security`).

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::io::RawHandle;

    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::core::PCWSTR;

    /// RAII wrapper around a Windows Job Object HANDLE. `Drop` closes the
    /// handle; because the job was created with `KILL_ON_JOB_CLOSE`, closing
    /// the LAST handle to it also kills any process still assigned — this is
    /// what makes a DevDeck crash (no cleanup code runs) still reap every
    /// service tree.
    ///
    /// Send/Sync: a job object HANDLE is a process-wide kernel token; the
    /// only operations performed (`TerminateJobObject`, `CloseHandle`) are
    /// thread-safe kernel32 calls, and the handle is closed exactly once in
    /// `Drop`. Tokio itself relies on the same reasoning for its `Waiting`
    /// type holding a HANDLE (process/windows.rs).
    pub struct ServiceJob {
        handle: HANDLE,
    }

    // SAFETY: see doc-comment above — HANDLE itself is just a pointer-sized
    // kernel object reference; every op we perform on it is a thread-safe
    // kernel32 call, and we never mutate shared state without synchronization
    // beyond what the OS itself guarantees for job object handles.
    unsafe impl Send for ServiceJob {}
    unsafe impl Sync for ServiceJob {}

    impl Drop for ServiceJob {
        fn drop(&mut self) {
            // SAFETY: `self.handle` was created by `CreateJobObjectW` in
            // `create_and_assign` and is closed here exactly once.
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }

    impl ServiceJob {
        /// Create a fresh Job Object, set `KILL_ON_JOB_CLOSE`, and assign
        /// `process` to it. Construction order matters (design Q3):
        /// 1. `CreateJobObjectW` — get the raw handle.
        /// 2. Wrap it in `Self` IMMEDIATELY so any later `?` auto-closes via
        ///    `Drop` (RAII, no manual leak handling on the error paths).
        /// 3. `SetInformationJobObject` with the KILL_ON_JOB_CLOSE limit.
        /// 4. `AssignProcessToJobObject`.
        pub fn create_and_assign(process: RawHandle) -> io::Result<Self> {
            // SAFETY: `None` security attributes and a null name are valid
            // per the Win32 contract for CreateJobObjectW; the returned
            // HANDLE is owned by us from this point on.
            let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
                .map_err(|e| io::Error::other(format!("CreateJobObjectW failed: {e}")))?;
            // Wrap immediately: from here on, any `?` below runs this
            // struct's Drop and closes `handle` — no leak on error.
            let job = Self { handle };

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `info` is a valid, fully-initialized
            // JOBOBJECT_EXTENDED_LIMIT_INFORMATION and its size matches the
            // `len` argument, as required by SetInformationJobObject.
            unsafe {
                SetInformationJobObject(
                    job.handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            }
            .map_err(|e| io::Error::other(format!("SetInformationJobObject failed: {e}")))?;

            // SAFETY: `process` is a valid process HANDLE obtained from the
            // tokio child we just spawned (still alive at this point); we do
            // not own/close it — std owns it, we only reference it here.
            unsafe { AssignProcessToJobObject(job.handle, HANDLE(process as *mut c_void)) }
                .map_err(|e| io::Error::other(format!("AssignProcessToJobObject failed: {e}")))?;

            Ok(job)
        }

        /// Kill every process currently in the job — the tree-kill primitive
        /// used by both escalation ladder steps (Terminate/ForceKill map to
        /// the same call here, exactly as `taskkill` did before this change).
        pub fn terminate(&self) -> io::Result<()> {
            // SAFETY: `self.handle` is a valid, still-open job object handle
            // for the lifetime of `self`.
            unsafe { TerminateJobObject(self.handle, 1) }
                .map_err(|e| io::Error::other(format!("TerminateJobObject failed: {e}")))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    /// Never-constructed stub — keeps `super::manager` `cfg`-free at its
    /// `Entry.job` / `kill_run_tree` call sites. Job Objects are a
    /// Windows-only concept; on Unix/WSL the existing `killpg` /
    /// `signal_group_wsl` paths are untouched (spec Non-Regression
    /// Requirements).
    pub struct ServiceJob;

    impl ServiceJob {
        pub fn terminate(&self) -> std::io::Result<()> {
            Ok(())
        }
    }
}

pub use imp::ServiceJob;

#[cfg(all(test, windows))]
mod tests {
    use std::time::Duration;

    use tokio::process::{Child, Command};

    use super::ServiceJob;

    /// Poll `try_wait()` until the child has exited or `timeout` elapses;
    /// returns `true` if it exited within the bound.
    async fn wait_exited(child: &mut Child, timeout: Duration) -> bool {
        tokio::time::timeout(timeout, async {
            loop {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .is_ok()
    }

    fn spawn_ping(script: &str) -> Child {
        Command::new("cmd")
            .args(["/C", script])
            .spawn()
            .expect("failed to spawn cmd.exe")
    }

    #[tokio::test]
    async fn create_and_assign_then_terminate_kills_the_child() {
        let mut child = spawn_ping("ping -n 30 127.0.0.1 >nul");
        let raw = child.raw_handle().expect("child should still be running");
        let job = ServiceJob::create_and_assign(raw).expect("job assignment failed");

        assert!(
            matches!(child.try_wait(), Ok(None)),
            "child should still be alive right after assignment"
        );

        job.terminate().expect("terminate failed");
        assert!(
            wait_exited(&mut child, Duration::from_secs(5)).await,
            "child did not exit after TerminateJobObject"
        );
    }

    #[tokio::test]
    async fn dropping_the_job_without_terminate_still_kills_the_child() {
        let mut child = spawn_ping("ping -n 30 127.0.0.1 >nul");
        let raw = child.raw_handle().expect("child should still be running");
        let job = ServiceJob::create_and_assign(raw).expect("job assignment failed");

        drop(job); // no explicit terminate() — relies on KILL_ON_JOB_CLOSE

        assert!(
            wait_exited(&mut child, Duration::from_secs(5)).await,
            "child survived dropping its only job handle"
        );
    }

    #[tokio::test]
    async fn terminate_kills_the_whole_tree_including_grandchildren() {
        // Nested shell so the direct child (outer cmd) spawns a grandchild
        // (inner cmd) which spawns the actual ping — mirrors mvnw.cmd -> java.exe.
        let mut child = spawn_ping("cmd /C cmd /C ping -n 30 127.0.0.1 >nul");
        let raw = child.raw_handle().expect("child should still be running");
        let job = ServiceJob::create_and_assign(raw).expect("job assignment failed");

        job.terminate().expect("terminate failed");
        assert!(
            wait_exited(&mut child, Duration::from_secs(5)).await,
            "direct child (outer cmd) did not exit after TerminateJobObject"
        );
        // Best-effort: confirm no lingering ping.exe holds on — tasklist is
        // the simplest zero-dependency check available in this test module.
        let output = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq ping.exe"])
            .output()
            .expect("tasklist failed");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            !stdout.contains("ping.exe"),
            "a ping.exe descendant survived TerminateJobObject: {stdout}"
        );
    }
}

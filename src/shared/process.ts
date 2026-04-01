/**
 * Cross-platform process utilities.
 *
 * Node.js `process.kill(pid, signal)` sends POSIX signals on Unix but on
 * Windows only signal 0 (liveness check) and SIGTERM (which unconditionally
 * terminates the process) are supported.  SIGKILL, SIGINT, etc. are **not**
 * supported — they throw EINVAL or are silently ignored.
 *
 * The helpers below provide reliable cross-platform semantics.
 */

import { execSync } from "child_process";

/**
 * Gracefully terminate a process.
 * - Unix: sends SIGTERM
 * - Windows: uses `taskkill /PID <pid>` (graceful)
 */
export function terminateProcess(pid: number): void {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid}`, { timeout: 5000, stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    /* process already gone */
  }
}

/**
 * Forcefully kill a process.
 * - Unix: sends SIGKILL
 * - Windows: uses `taskkill /F /PID <pid>` (force)
 */
export function forceKillProcess(pid: number): void {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /PID ${pid}`, { timeout: 5000, stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    /* process already gone */
  }
}

/**
 * Register cross-platform cleanup handlers for process termination.
 *
 * On Unix, SIGINT/SIGTERM are the standard signals for graceful shutdown.
 * On Windows, these signals are not reliably delivered; instead we listen
 * for the `exit` event which fires when the process is about to terminate
 * (e.g. from taskkill, Ctrl+C on Windows console, or parent death).
 *
 * The callback will be invoked at most once.
 */
export function onProcessTermination(callback: () => void): void {
  let called = false;
  const once = () => {
    if (called) return;
    called = true;
    callback();
  };

  if (process.platform === "win32") {
    // On Windows, 'exit' fires for taskkill, Ctrl+C, and parent death.
    // Also listen for SIGINT which Node.js translates from Ctrl+C on Windows console.
    process.on("exit", once);
    process.on("SIGINT", once);
  } else {
    process.on("SIGINT", once);
    process.on("SIGTERM", once);
  }
}

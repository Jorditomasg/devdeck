/**
 * git stderr fragments meaning "credentials missing or rejected" (HTTPS and
 * SSH). The Rust side disables terminal prompts (`GIT_TERMINAL_PROMPT=0`),
 * so a repo needing a login fails fast with one of these instead of hanging.
 */
const AUTH_ERROR =
  /terminal prompts disabled|could not read (username|password)|authentication failed|invalid username or password|returned error: 40[13]|permission denied \(publickey|host key verification failed/i;

export function isGitAuthError(message: string): boolean {
  return AUTH_ERROR.test(message);
}

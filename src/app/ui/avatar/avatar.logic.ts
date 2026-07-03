/**
 * Avatar identity helpers (git suite phase 1, design doc 2026-07-02):
 * Gravatar by SHA-256 of the email with a deterministic initials fallback —
 * no tokens, no hosting-specific APIs, works offline (initials).
 */

/** Gravatar image size (px) requested for commit avatars. */
export const GRAVATAR_SIZE = 64;

/**
 * Initials for the fallback disc: first letters of the first two words
 * (`"Jordi Tomás"` → `"JT"`), uppercased; single-word names give one letter.
 */
export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 2)
    .map((w) => (w[0] ?? '').toUpperCase())
    .join('');
}

/**
 * Deterministic hue (0-359) from a seed string — same email, same color,
 * every session. Plain djb2-style fold; distribution is good enough for
 * telling authors apart.
 */
export function hueOf(seed: string): number {
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 33 + seed.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

/**
 * Gravatar URL for an email (SHA-256 — supported and recommended by
 * Gravatar; avoids shipping an MD5 implementation). `d=404` so a missing
 * avatar errors the `<img>` and the initials fallback shows instead.
 */
export async function gravatarUrl(
  email: string,
  size: number = GRAVATAR_SIZE,
): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `https://gravatar.com/avatar/${hex}?d=404&s=${size}`;
}

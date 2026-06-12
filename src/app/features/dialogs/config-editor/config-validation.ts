/**
 * Client-side config-content validation for the editor dialog.
 *
 * DOCUMENTED CHOICE: the IPC contract has NO generic "validate" command
 * (only `apply_environment` validates spring YAML during env application,
 * ipc-contract.md §2.5 #35), so save-time validation is a deliberately
 * conservative CLIENT-SIDE heuristic: it only reports problems that are
 * unambiguously wrong for the format, never blocks a save (the dialog asks
 * "save anyway?"), and unknown formats are never validated.
 */

export type ConfigFormat = 'yaml' | 'properties' | 'other';

/** Classify a config file by extension (v1 spring writer's yml/properties pair). */
export function detectFormat(filename: string): ConfigFormat {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
    return 'yaml';
  }
  if (lower.endsWith('.properties')) {
    return 'properties';
  }
  return 'other';
}

/**
 * Validate content for a format. Returns human-readable problem descriptions
 * (empty array = no problems found). Conservative on purpose — a false
 * positive that blocks a developer is worse than a miss the backend/server
 * will surface anyway.
 */
export function validateConfigContent(
  format: ConfigFormat,
  content: string,
): string[] {
  switch (format) {
    case 'yaml':
      return validateYaml(content);
    case 'properties':
      return validateProperties(content);
    case 'other':
      return [];
  }
}

/** YAML: tabs in indentation are a hard spec error; duplicate top-level keys. */
function validateYaml(content: string): string[] {
  const problems: string[] = [];
  const seenTopLevel = new Set<string>();
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    if (/^[ ]*\t/.test(line)) {
      problems.push(`line ${i + 1}: tab character in indentation (YAML forbids tabs)`);
    }
    // Top-level scalar keys only (column 0, simple `key:`); block scalars,
    // comments and document markers are skipped.
    const keyMatch = /^([A-Za-z0-9_.-]+):(\s|$)/.exec(line);
    if (keyMatch) {
      const key = keyMatch[1];
      if (seenTopLevel.has(key)) {
        problems.push(`line ${i + 1}: duplicate top-level key '${key}'`);
      }
      seenTopLevel.add(key);
    }
  });
  return problems;
}

/** .properties: every line is blank, a comment (#/!), a continuation, or k=v / k:v. */
function validateProperties(content: string): string[] {
  const problems: string[] = [];
  let continuation = false;
  content.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    const wasContinuation = continuation;
    continuation = /\\$/.test(line.trimEnd());
    if (wasContinuation) {
      return; // belongs to the previous logical line
    }
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) {
      continuation = false;
      return;
    }
    if (!/[=:]/.test(trimmed)) {
      problems.push(`line ${i + 1}: expected 'key=value' (no '=' or ':' found)`);
    }
  });
  return problems;
}

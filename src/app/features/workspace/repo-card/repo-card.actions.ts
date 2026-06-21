/**
 * Repo-card action registry — the single place declarable per-type action
 * buttons (YAML `ui.actions`, e.g. `["seed"]`) are mapped to their icon,
 * i18n label key and IPC command. The card resolves the repo's declared keys
 * through {@link resolveActions} and renders one button per resolved action,
 * dropping any unknown key. Adding a new action = one entry here (plus the
 * backend command in `CMD` and the `repo.action.<key>` i18n key).
 */
import { CMD, type CommandName } from '../../../core/ipc/commands';

/** Metadata for one declarable repo-card action button. */
export interface RepoCardAction {
  readonly key: string;
  readonly icon: string;
  /** i18n key for the button label/tooltip. */
  readonly labelKey: string;
  readonly command: CommandName;
}

/** THE single place repo-card actions are registered. Add new actions here. */
export const REPO_CARD_ACTIONS: Readonly<Record<string, RepoCardAction>> = {
  seed: {
    key: 'seed',
    icon: '🌱',
    labelKey: 'repo.action.seed',
    command: CMD.runFlywaySeeds,
  },
};

/** Resolve declared action keys to their metadata, skipping unknown keys. */
export function resolveActions(
  keys: readonly string[] | undefined,
): RepoCardAction[] {
  return (keys ?? [])
    .map((k) => REPO_CARD_ACTIONS[k])
    .filter((a): a is RepoCardAction => !!a);
}

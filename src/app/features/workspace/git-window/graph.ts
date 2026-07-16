/**
 * Commit-graph lane assignment (git suite phase 2, design doc 2026-07-02).
 *
 * Classic "active lanes" walk over a topo-ordered commit page (newest
 * first, `git log --topo-order` — guaranteed by the backend): each lane
 * holds the sha it expects next; a commit takes the first lane waiting for
 * it (or a free one when it is a branch tip), its first parent continues
 * the lane, extra parents (merges) connect to existing lanes or open new
 * ones. Pure and page-local: recomputed per loaded page, read-only —
 * deliberately NOT an interactive graph (design decision, phase 1
 * brainstorm: that is GitKraken's headcount, not ours).
 */

export interface GraphInput {
  readonly sha: string;
  readonly parents: readonly string[];
  /** Ref decorations (`%D` entries) — enable lane labeling when present. */
  readonly refs?: readonly string[];
  /** Commit subject — merge subjects name the merged-in branch. */
  readonly subject?: string;
  /** `%S` reaching ref — names commits when refs/inheritance can't. */
  readonly source?: string;
}

/** Drawing instructions for one commit row (all values are lane indexes). */
export interface GraphRow {
  /** Column of the commit dot. */
  readonly lane: number;
  /** Lanes entering the row top that converge into the dot (children). */
  readonly fromTop: readonly number[];
  /** Lanes leaving the dot to the row bottom (parents; merges fan out). */
  readonly toBottom: readonly number[];
  /** Unrelated lanes passing straight through the row. */
  readonly through: readonly number[];
  /** Active lane count at this row (for row width). */
  readonly width: number;
  /**
   * Best-effort branch name of the commit's line: ref decorations at tips,
   * inherited down the first-parent chain, and parsed out of merge subjects
   * for merged-in branches (git only KNOWS names at refs — everything else
   * is propagation, same trick GitLens uses). `undefined` = unknown.
   */
  readonly label?: string;
  /**
   * The label is a real, walkable REF (decoration, `%S` source, or
   * inherited from one) — filterable on click. Labels parsed from merge
   * subjects are display-only: their branch was deleted (2026-07-04).
   */
  readonly labelLive: boolean;
  /** Per-lane propagated branch names at this row (index = lane). */
  readonly labels: readonly (string | undefined)[];
  /** Per-lane provenance flags matching `labels` (line click gating). */
  readonly labelsLive: readonly (boolean | undefined)[];
  /** Same snapshot at the row TOP (before this commit mutated the lanes) —
   *  colors the fromTop edges so convergence elbows keep their line's color. */
  readonly topLabels: readonly (string | undefined)[];
  /**
   * Lanes whose edge out of this row leads to a commit NOT in the loaded
   * list (filters skip commits, or it lies beyond the loaded pages). The
   * lane is CLOSED right away — rendered as a short dashed stub ("same
   * branch, commits in between") instead of an endless open vertical, so
   * filtered views don't drift rightward (user report 2026-07-03).
   */
  readonly dangling: readonly number[];
}

/** Best branch-ish name out of `%D` decorations: local branch > remote > tag. */
export function pickRefLabel(refs: readonly string[] | undefined): string | undefined {
  if (!refs || refs.length === 0) {
    return undefined;
  }
  const names = refs.map((r) => r.replace(/^HEAD -> /, '')).filter((r) => r !== 'HEAD');
  const local = names.find((r) => !r.startsWith('origin/') && !r.startsWith('tag: '));
  const remote = names.find((r) => r.startsWith('origin/'));
  const tag = names.find((r) => r.startsWith('tag: '))?.replace(/^tag: /, '');
  return local ?? remote ?? tag;
}

/**
 * Branch named by a merge-commit subject: `Merge branch 'x'` /
 * `Merge remote-tracking branch 'origin/x'` / GitHub's
 * `Merge pull request #N from owner/x` (owner segment stripped).
 */
export function mergedBranchOf(subject: string | undefined): string | undefined {
  if (!subject) {
    return undefined;
  }
  const quoted = /Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject);
  if (quoted) {
    return quoted[1];
  }
  const pr = /Merge pull request #\d+ from (\S+)/.exec(subject);
  if (pr) {
    const full = pr[1];
    const slash = full.indexOf('/');
    return slash === -1 ? full : full.slice(slash + 1);
  }
  return undefined;
}

/**
 * Branch a merge subject says it merged INTO — `Merge <anything> into y`.
 * Counterpart of [`mergedBranchOf`]: names the commit's OWN line. On Azure
 * DevOps repos the back-merges ("Merge remote-tracking branch
 * 'origin/develop' into feature/r15-to-dev") are often the ONLY thing that
 * names a deleted feature branch — its ref is gone and the PR merge subject
 * ("Merged PR 9422: <title>") carries no branch name (user 2026-07-16).
 */
export function mergeTargetOf(subject: string | undefined): string | undefined {
  if (!subject || !subject.startsWith('Merge')) {
    return undefined;
  }
  // Greedy `.+` → LAST " into "; quote excluded so a quoted branch name
  // containing "into" can't bleed a trailing `'` into the capture.
  const m = /^Merge .+ into ([^'\s]+)$/.exec(subject);
  return m ? m[1] : undefined;
}

/**
 * Assign lanes to a topo-ordered commit list. The final page may reference
 * parents that are not loaded yet — their lanes simply stay open through
 * the last row (correct: the line continues past the page).
 */
/** One active lane: the sha it expects next + its propagated branch name. */
interface LaneSlot {
  sha: string;
  label?: string;
  /** Label provenance — see [`GraphRow.labelLive`]. */
  live: boolean;
  /**
   * Lane opened by a merge whose subject couldn't name it, still unnamed.
   * Suppresses the `%S` label fallback: the walk reaches a deleted branch's
   * commits from the ref it was merged INTO, so `%S` stamps the TARGET
   * branch's name (develop) on every merged-in feature lane — technically
   * reachable, semantically wrong (user 2026-07-16, Azure DevOps repo where
   * every lane read "develop"). Left unnamed, backfill can name the run
   * from an `into <branch>` subject below instead.
   */
  fanout: boolean;
}

/**
 * Compute the lane graph. `linear` collapses everything to ONE column —
 * for views whose filters (author/text/path/dates) break topological
 * contiguity: parallel-chain lanes there read as "duplicate branches"
 * (user 2026-07-04). Solid edge only between DIRECT parent-child rows;
 * fading stub otherwise.
 */
export function computeGraph(
  commits: readonly GraphInput[],
  opts: { linear?: boolean } = {},
): GraphRow[] {
  if (opts.linear) {
    return computeLinear(commits);
  }
  const lanes: (LaneSlot | null)[] = [];
  const rows: GraphRow[] = [];
  const loaded = new Set(commits.map((c) => c.sha));

  for (const commit of commits) {
    const topActive = lanes.map((s) => s !== null);
    const topLabels = lanes.map((s) => s?.label);

    const waiting: number[] = [];
    lanes.forEach((slot, i) => {
      if (slot?.sha === commit.sha) {
        waiting.push(i);
      }
    });

    let lane: number;
    if (waiting.length > 0) {
      lane = waiting[0];
    } else {
      const free = lanes.indexOf(null);
      lane = free !== -1 ? free : lanes.length;
      if (free === -1) {
        lanes.push(null);
      }
    }
    // Decorations win; then the branch this commit's own merge subject says
    // it merged INTO; then the line's inherited name; then git's per-commit
    // reaching ref (%S — names filtered-view segments too, but suppressed on
    // unnamed merge fan-out lanes, see LaneSlot.fanout). Every step here is
    // a REAL ref except the subject-parsed names — provenance rides along
    // (labelLive).
    const refLabel = pickRefLabel(commit.refs);
    const intoTarget = mergeTargetOf(commit.subject);
    const inherited = lanes[lane];
    const sourceLabel = inherited?.fanout ? undefined : commit.source || undefined;
    const label = refLabel ?? intoTarget ?? inherited?.label ?? sourceLabel;
    // Live when it came from a real ref — including a subject-parsed name
    // CONFIRMED by %S (fork-PR merges name the walked branch itself, e.g.
    // spring's "Merge pull request from spring-projects/1.5.x" ON 1.5.x).
    const labelLive =
      refLabel !== undefined
        ? true
        : intoTarget !== undefined
          ? intoTarget === commit.source
          : inherited?.label !== undefined
            ? inherited.live || inherited.label === commit.source
            : label !== undefined;
    // Converged children free their lanes (the dot's own lane is reused).
    for (const j of waiting) {
      if (j !== lane) {
        lanes[j] = null;
      }
    }

    const toBottom: number[] = [];
    const dangling: number[] = [];
    const [first, ...rest] = commit.parents;
    if (first === undefined) {
      lanes[lane] = null; // root commit ends the line
    } else if (!loaded.has(first)) {
      // Parent not in the loaded list (filtered out or beyond the page):
      // dashed stub below the dot, lane closed — recomputed as solid once
      // load-more brings the parent in.
      lanes[lane] = null;
      toBottom.push(lane);
      dangling.push(lane);
    } else {
      // First parent: converge into a LOWER lane that already expects it
      // (join the main line as early as possible — keeps the graph narrow);
      // a HIGHER lane expecting the same parent keeps flowing and joins at
      // the fork commit's dot instead (main line never bends rightward).
      const existing = lanes.findIndex((slot, i) => slot?.sha === first && i < lane);
      if (existing !== -1) {
        toBottom.push(existing);
        lanes[lane] = null;
      } else {
        lanes[lane] = {
          sha: first,
          label,
          live: labelLive,
          // A still-unnamed fan-out run keeps suppressing %S downward.
          fanout: label === undefined && inherited?.fanout === true,
        };
        toBottom.push(lane);
      }
    }
    if (first !== undefined) {
      rest.forEach((parent, n) => {
        const idx = lanes.findIndex((slot) => slot?.sha === parent);
        if (idx !== -1) {
          toBottom.push(idx);
        } else if (!loaded.has(parent)) {
          // Unloaded merge parent: dashed stub on a transient lane slot.
          const free = lanes.indexOf(null);
          const k = free !== -1 ? free : lanes.length;
          if (free === -1) {
            lanes.push(null);
          }
          toBottom.push(k);
          dangling.push(k);
        } else {
          // The merged-in branch: its tip usually lost its ref (deleted
          // after merge), but the merge subject names it (2nd parent only).
          const mergedName = n === 0 ? mergedBranchOf(commit.subject) : undefined;
          const slot: LaneSlot = {
            sha: parent,
            label: mergedName,
            // Usually a deleted branch — but a subject naming the WALKED
            // ref itself (fork-PR merges) is confirmed real by %S.
            live: mergedName !== undefined && mergedName === commit.source,
            fanout: mergedName === undefined,
          };
          const free = lanes.indexOf(null);
          const k = free !== -1 ? free : lanes.length;
          if (free === -1) {
            lanes.push(slot);
          } else {
            lanes[k] = slot;
          }
          toBottom.push(k);
        }
      });
    }

    // A lane counts as through when it was active at the row top and stays
    // active at the bottom — INCLUDING lanes that also appear in toBottom
    // (early convergence / merge-into-existing): their line keeps flowing
    // top→bottom and the elbow JOINS it. Excluding them cut the main line
    // exactly where a branch merged in (user report 2026-07-03, reproduced
    // on spring-petclinic rows 18-19).
    const through: number[] = [];
    lanes.forEach((slot, i) => {
      if (slot !== null && i !== lane && topActive[i] && !waiting.includes(i)) {
        through.push(i);
      }
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }

    rows.push({
      lane,
      fromTop: waiting,
      toBottom,
      through,
      width: Math.max(
        lanes.length,
        lane + 1,
        ...through.map((t) => t + 1),
        ...toBottom.map((t) => t + 1),
      ),
      label,
      labelLive,
      labels: lanes.map((slot) => slot?.label),
      labelsLive: lanes.map((slot) => slot?.live),
      topLabels,
      dangling,
    });
  }
  backfillUnnamedLanes(rows);
  return rows;
}

/**
 * Name merge-opened lanes AFTER the fact. Azure DevOps merge subjects
 * ("Merged PR 9469: <title>") carry no branch name, so the fan-out lane
 * stays unlabeled until the tip commit's refs/%S name it — one row too late
 * for the edges above, which fell back to the MERGE's color (user
 * 2026-07-15: orange segment on top of the green feature branch). Walk
 * bottom-up: when a dot's incoming own-lane run is unnamed, push the dot's
 * label up to the row that opened the lane.
 */
function backfillUnnamedLanes(rows: GraphRow[]): void {
  for (let t = rows.length - 1; t >= 0; t--) {
    const tip = rows[t];
    const lane = tip.lane;
    if (tip.label === undefined || !tip.fromTop.includes(lane)) {
      continue;
    }
    if (tip.topLabels[lane] !== undefined) {
      continue; // run already named (subject parse or inheritance)
    }
    (tip.topLabels as (string | undefined)[])[lane] = tip.label;
    for (let r = t - 1; r >= 0; r--) {
      const row = rows[r];
      if (row.labels[lane] !== undefined) {
        break; // different, named run — never ours
      }
      (row.labels as (string | undefined)[])[lane] = tip.label;
      (row.labelsLive as (boolean | undefined)[])[lane] = tip.labelLive;
      if (row.lane === lane) {
        // Unnamed commit ON the run (%S suppressed on Azure fan-out lanes,
        // 2026-07-16): the run's name is its name — chip included.
        if (row.label === undefined) {
          (row as { label?: string }).label = tip.label;
          (row as { labelLive: boolean }).labelLive = tip.labelLive;
        }
        if (!row.fromTop.includes(lane)) {
          break; // the run's top commit (ring tip) — done
        }
        (row.topLabels as (string | undefined)[])[lane] = tip.label;
        continue;
      }
      if (row.toBottom.includes(lane) && !row.through.includes(lane)) {
        break; // the row that OPENED the lane (merge fan-out) — done
      }
      (row.topLabels as (string | undefined)[])[lane] = tip.label;
    }
  }
}

/** Single-column timeline for filter-fragmented views (see computeGraph). */
function computeLinear(commits: readonly GraphInput[]): GraphRow[] {
  const rows: GraphRow[] = [];
  let prevSolid = false;
  let prevLabel: string | undefined;
  let prevLive = false;

  commits.forEach((commit, i) => {
    const refLabel = pickRefLabel(commit.refs);
    const inherited = prevSolid ? prevLabel : undefined;
    const label = refLabel ?? inherited ?? (commit.source || undefined);
    const labelLive =
      refLabel !== undefined
        ? true
        : inherited !== undefined
          ? prevLive || inherited === commit.source
          : label !== undefined;

    const next = commits[i + 1];
    const hasParents = commit.parents.length > 0;
    const solidDown = hasParents && next !== undefined && commit.parents.includes(next.sha);

    rows.push({
      lane: 0,
      fromTop: prevSolid ? [0] : [],
      toBottom: hasParents ? [0] : [],
      through: [],
      width: 1,
      label,
      labelLive,
      labels: [hasParents ? label : undefined],
      labelsLive: [hasParents ? labelLive : undefined],
      topLabels: prevSolid ? [prevLabel] : [],
      dangling: hasParents && !solidDown ? [0] : [],
    });

    prevSolid = solidDown;
    prevLabel = label;
    prevLive = labelLive;
  });
  return rows;
}

/**
 * Assign palette colors to the DISTINCT labels of a page, first-seen order —
 * no collisions until the palette runs out (hash coloring made two visible
 * branches share a color, user 2026-07-04). Recomputed with the rows, so a
 * label keeps its color for the lifetime of the loaded view.
 */
export function assignBranchColors(rows: readonly GraphRow[]): ReadonlyMap<string, string> {
  const colors = new Map<string, string>();
  const claim = (label: string | undefined): void => {
    if (label !== undefined && !colors.has(label)) {
      colors.set(label, LANE_COLORS[colors.size % LANE_COLORS.length]);
    }
  };
  for (const row of rows) {
    claim(row.label);
    row.labels.forEach(claim);
  }
  return colors;
}

/** Widest row of the page — every row renders at this width so lanes align. */
export function graphWidth(rows: readonly GraphRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.width), 1);
}

/** Palette for branch/lane colors (distinct, dark-theme friendly). */
export const LANE_COLORS = [
  '#4e9de6',
  '#e6a23c',
  '#67c23a',
  '#c678dd',
  '#e06c75',
  '#56b6c2',
  '#d19a66',
  '#98c379',
  '#e05299',
  '#3fc1c9',
  '#f4d35e',
  '#9d8df1',
] as const;

export function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

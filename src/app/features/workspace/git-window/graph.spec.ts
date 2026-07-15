import { describe, expect, it } from 'vitest';

import {
  assignBranchColors,
  computeGraph,
  graphWidth,
  laneColor,
  mergedBranchOf,
  pickRefLabel,
  LANE_COLORS,
} from './graph';

describe('computeGraph', () => {
  it('keeps a linear history on one lane', () => {
    const rows = computeGraph([
      { sha: 'c', parents: ['b'] },
      { sha: 'b', parents: ['a'] },
      { sha: 'a', parents: [] },
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[0].fromTop).toEqual([]); // tip: nothing above
    expect(rows[0].toBottom).toEqual([0]);
    expect(rows[1].fromTop).toEqual([0]);
    expect(rows[2].toBottom).toEqual([]); // root: line ends
    expect(graphWidth(rows)).toBe(1);
  });

  it('fans a merge out to a second lane and joins it at the fork point', () => {
    // m = merge of b (main, first parent) + f (feature)
    //   m        lane 0, parents b,f → f opens lane 1
    //   f        lane 1
    //   b        lane 0
    //   a        fork point: f's parent AND b's parent converge here
    const rows = computeGraph([
      { sha: 'm', parents: ['b', 'f'] },
      { sha: 'f', parents: ['a'] },
      { sha: 'b', parents: ['a'] },
      { sha: 'a', parents: [] },
    ]);
    expect(rows[0].lane).toBe(0);
    expect(rows[0].toBottom).toEqual([0, 1]); // merge fan-out
    expect(rows[1].lane).toBe(1); // feature commit on its own lane
    expect(rows[1].through).toEqual([0]); // main line passes through
    expect(rows[2].lane).toBe(0);
    // Both lanes wait for 'a': first-parent continues lane 0, feature lane
    // merges into it (lane 1 freed at the fork point).
    expect(rows[3].lane).toBe(0);
    expect(rows[3].fromTop).toEqual([0, 1]);
    expect(graphWidth(rows)).toBe(2);
  });

  it('reuses freed lanes and converges tips into the main line early', () => {
    const rows = computeGraph([
      { sha: 'm', parents: ['b', 'f'] },
      { sha: 'f', parents: ['b'] }, // feature joins lane 0 (lower) right away
      { sha: 'x', parents: ['b'] }, // unrelated tip: takes freed lane 1
      { sha: 'b', parents: [] },
    ]);
    expect(rows[1].lane).toBe(1);
    expect(rows[1].toBottom).toEqual([0]); // early convergence into main
    expect(rows[1].through).toEqual([0]); // …and main keeps flowing THROUGH
    expect(rows[2].lane).toBe(1); // freed lane reused
    expect(rows[2].toBottom).toEqual([0]);
    expect(rows[2].through).toEqual([0]);
    expect(rows[3].fromTop).toEqual([0]); // everything already on the main line
  });

  it('keeps the target lane flowing through an early-convergence row', () => {
    // Real spring-petclinic pattern (rows 18-19 of the reproduction): a
    // branch commit converges into lane 0 while lane 0 has commits BELOW —
    // lane 0 must stay in `through` or its line gets chopped mid-row.
    const rows = computeGraph([
      { sha: 'm', parents: ['c', 'x2'] },
      { sha: 'x2', parents: ['x1'] }, // branch, lane 1; c passes through
      { sha: 'x1', parents: ['c'] }, // converges into lane 0 (expects c)
      { sha: 'c', parents: [] },
    ]);
    expect(rows[2].lane).toBe(1);
    expect(rows[2].toBottom).toEqual([0]);
    expect(rows[2].through).toEqual([0]); // the cut line, before the fix
    // Continuity invariant across every consecutive row pair:
    for (let r = 0; r + 1 < rows.length; r++) {
      const bottom = new Set([...rows[r].through, ...rows[r].toBottom]);
      const top = new Set([...rows[r + 1].through, ...rows[r + 1].fromTop]);
      for (const lane of bottom) {
        expect(top.has(lane), `lane ${lane} continuity rows ${r}→${r + 1}`).toBe(true);
      }
    }
  });

  it('handles a page whose last rows reference unloaded parents', () => {
    const rows = computeGraph([{ sha: 'z', parents: ['unloaded'] }]);
    expect(rows[0].toBottom).toEqual([0]); // line stays open past the page
  });
});

describe('lane labels', () => {
  it('prefers local branch over remote over tag in decorations', () => {
    expect(pickRefLabel(['HEAD -> master', 'origin/master', 'tag: v2.1.0'])).toBe('master');
    expect(pickRefLabel(['origin/main', 'tag: v1'])).toBe('origin/main');
    expect(pickRefLabel(['tag: v1'])).toBe('v1');
    expect(pickRefLabel([])).toBeUndefined();
    expect(pickRefLabel(undefined)).toBeUndefined();
  });

  it('extracts the merged branch from merge subjects', () => {
    expect(mergedBranchOf("Merge branch 'feature/x'")).toBe('feature/x');
    expect(mergedBranchOf("Merge remote-tracking branch 'origin/dev'")).toBe('origin/dev');
    expect(mergedBranchOf('Merge pull request #805 from DanielFran/upgrade-maven')).toBe(
      'upgrade-maven',
    );
    expect(mergedBranchOf('feat: normal commit')).toBeUndefined();
    expect(mergedBranchOf(undefined)).toBeUndefined();
  });

  it('propagates labels down the first-parent chain and into merged lanes', () => {
    const rows = computeGraph([
      {
        sha: 'm',
        parents: ['c', 'x'],
        refs: ['HEAD -> main', 'origin/main'],
        subject: "Merge branch 'feature/y'",
      },
      { sha: 'x', parents: ['b'] }, // merged branch commit: named by the subject
      { sha: 'c', parents: ['b'] }, // main line: inherits 'main'
      { sha: 'b', parents: [] },
    ]);
    expect(rows[0].label).toBe('main');
    expect(rows[1].label).toBe('feature/y');
    expect(rows[2].label).toBe('main');
    expect(rows[3].label).toBe('main'); // fork point sits on the main line
  });
});

describe('dangling edges (dashed "commits in between")', () => {
  it('closes lanes to unloaded parents and reuses them (uniform columns)', () => {
    const rows = computeGraph([
      { sha: 'b', parents: ['skipped'] }, // filtered view: parent not loaded
      { sha: 'a', parents: [] },
    ]);
    expect(rows[0].dangling).toEqual([0]); // dashed stub below b
    expect(rows[0].toBottom).toEqual([0]);
    expect(rows[1].lane).toBe(0); // lane FREED and reused — no rightward drift
    expect(rows[1].fromTop).toEqual([]); // next segment starts fresh (ring tip)
    expect(rows[1].through).toEqual([]);

    const solid = computeGraph([
      { sha: 'b', parents: ['a'] },
      { sha: 'a', parents: [] },
    ]);
    expect(solid[0].dangling).toEqual([]);
  });

  it('falls back to the %S source ref for segment labels in filtered views', () => {
    const rows = computeGraph([
      { sha: 'b', parents: ['skipped'], source: 'main' },
      { sha: 'a', parents: ['gone'], source: 'feature/x' },
    ]);
    expect(rows[0].label).toBe('main');
    expect(rows[1].label).toBe('feature/x');
  });

  it('exposes per-lane labels for line tooltips/clicks', () => {
    const rows = computeGraph([
      { sha: 'm', parents: ['c', 'x'], refs: ['HEAD -> main'], subject: "Merge branch 'f'" },
      { sha: 'x', parents: ['c'] },
      { sha: 'c', parents: [] },
    ]);
    expect(rows[0].labels[0]).toBe('main'); // main line named below the merge
    expect(rows[0].labels[1]).toBe('f'); // merged lane named by the subject
    expect(rows[1].labels[0]).toBe('main'); // main passes through, named
    expect(rows[1].label).toBe('f'); // the branch commit itself (lane freed at convergence)
  });
});

describe('linear mode (fragmented filters)', () => {
  it('keeps everything on ONE column: solid for direct parents, stubs otherwise', () => {
    const rows = computeGraph(
      [
        { sha: 'c', parents: ['b'], source: '1.5.x' }, // direct parent next: solid
        { sha: 'b', parents: ['skipped'], source: '1.5.x' }, // gap: stub
        { sha: 'a', parents: [], source: '1.5.x' }, // root
      ],
      { linear: true },
    );
    expect(rows.every((r) => r.lane === 0 && r.through.length === 0)).toBe(true);
    expect(graphWidth(rows)).toBe(1); // the user's ask: one line
    expect(rows[0].dangling).toEqual([]); // solid into b
    expect(rows[1].fromTop).toEqual([0]);
    expect(rows[1].dangling).toEqual([0]); // fading stub into the gap
    expect(rows[2].fromTop).toEqual([]); // new segment (ring tip)
    expect(rows[2].toBottom).toEqual([]); // root
  });

  it('inherits labels across solid links and stays clickable', () => {
    const rows = computeGraph(
      [
        { sha: 'c', parents: ['b'], refs: ['HEAD -> 1.5.x'] },
        { sha: 'b', parents: ['x'], source: '1.5.x' },
      ],
      { linear: true },
    );
    expect(rows[1].label).toBe('1.5.x'); // inherited through the solid link
    expect(rows[1].labelLive).toBe(true);
  });
});

describe('firstParentLane (convergence-elbow color ownership)', () => {
  it('points the elbow at the dot line so a converging branch keeps its color', () => {
    // feature (lane 1) early-converges into main (lane 0). The elbow belongs
    // to the feature line, so edgeColor must follow the DOT (feature), not the
    // target lane (main) — the bug from the user report (2026-07-15).
    const rows = computeGraph([
      { sha: 'm', parents: ['b', 'f'], refs: ['HEAD -> main'], subject: "Merge branch 'feature'" },
      { sha: 'f', parents: ['b'] }, // early convergence into lane 0
      { sha: 'b', parents: [] },
    ]);
    expect(rows[1].lane).toBe(1);
    expect(rows[1].toBottom).toEqual([0]); // converges into main
    expect(rows[1].firstParentLane).toBe(0); // …but the elbow is the feature line
  });

  it('is the dot lane for a straight continuation and undefined at a root', () => {
    const rows = computeGraph([
      { sha: 'b', parents: ['a'] },
      { sha: 'a', parents: [] },
    ]);
    expect(rows[0].firstParentLane).toBe(0);
    expect(rows[1].firstParentLane).toBeUndefined(); // root: line ends
  });

  it('is the dot lane for a dangling first parent (fading stub is the line)', () => {
    const rows = computeGraph([{ sha: 'b', parents: ['skipped'] }, { sha: 'a', parents: [] }]);
    expect(rows[0].dangling).toEqual([0]);
    expect(rows[0].firstParentLane).toBe(0);
  });
});

describe('laneColor', () => {
  it('cycles the palette deterministically', () => {
    expect(laneColor(0)).toBe(LANE_COLORS[0]);
    expect(laneColor(LANE_COLORS.length)).toBe(LANE_COLORS[0]);
    expect(laneColor(3)).toBe(laneColor(3 + LANE_COLORS.length));
  });
});

describe('assignBranchColors', () => {
  it('gives every distinct visible label its own color, first-seen order', () => {
    const rows = computeGraph([
      { sha: 'b', parents: ['x'], source: 'main' },
      { sha: 'a', parents: ['y'], source: 'efficient-webjars' },
    ]);
    const palette = assignBranchColors(rows);
    // The exact regression: recycled lane 0 made these look like ONE line.
    expect(palette.get('main')).toBe(LANE_COLORS[0]);
    expect(palette.get('efficient-webjars')).toBe(LANE_COLORS[1]);
    expect(palette.get('main')).not.toBe(palette.get('efficient-webjars'));
  });
});

describe('labelLive (click provenance)', () => {
  it('marks ref/source labels live and merge-subject labels display-only', () => {
    const rows = computeGraph([
      {
        sha: 'm',
        parents: ['c', 'x'],
        refs: ['HEAD -> main'],
        subject: "Merge branch 'gone'",
        source: 'main',
      },
      { sha: 'x', parents: ['c'], source: 'main' }, // label 'gone' (subject)
      { sha: 'c', parents: [], source: 'main' },
    ]);
    expect(rows[0].labelLive).toBe(true); // decoration
    expect(rows[1].label).toBe('gone');
    expect(rows[1].labelLive).toBe(false); // deleted branch: not clickable
    expect(rows[2].labelLive).toBe(true); // inherited from decoration

    const filtered = computeGraph([{ sha: 'z', parents: ['p'], source: 'v2.6.0' }]);
    expect(filtered[0].label).toBe('v2.6.0');
    expect(filtered[0].labelLive).toBe(true); // %S = real ref (tag) — filterable
  });

  it('confirms fork-PR merge names against %S (spring 1.5.x case)', () => {
    // "Merge pull request from spring-projects/1.5.x" ON branch 1.5.x: the
    // subject names the WALKED ref itself → live, clickable (user 2026-07-04).
    const rows = computeGraph([
      {
        sha: 'm',
        parents: ['c', 'x'],
        subject: 'Merge pull request #9 from spring-projects/1.5.x',
        source: '1.5.x',
      },
      { sha: 'x', parents: ['gone2'], source: '1.5.x' }, // 2nd-parent chain
      { sha: 'c', parents: [], source: '1.5.x' },
    ]);
    expect(rows[0].labelsLive[1]).toBe(true); // merged lane confirmed by %S
    expect(rows[1].label).toBe('1.5.x');
    expect(rows[1].labelLive).toBe(true); // inherited name === source
  });
});

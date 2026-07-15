import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { laneColor, type GraphRow } from './graph';

/** Lane column width in px (dot sits at the column center). */
export const LANE_WIDTH = 14;
/** Fixed commit-row height — graph geometry depends on it. */
export const ROW_HEIGHT = 46;
/** Dangling stubs reach this far past the row edge (fading out). */
const STUB_OVERHANG = 9;

/**
 * One commit row's slice of the lane graph (phase 2): through-lines, elbow
 * curves converging into / fanning out of the dot, and the dot itself.
 *
 * Interactivity lives ONLY on the dot (user 2026-07-04: line hover/click
 * was ambiguous — clicks near the dot hit the wrong target): an invisible
 * hit circle shows the branch-name tooltip for every dot, and for LIVE
 * branches adds a halo on hover + click-to-filter. Lines are inert.
 *
 * Dangling edges (parent not loaded: filters skip commits, or it lies
 * beyond the loaded pages) start SOLID at the dot and FADE OUT downward via
 * an SVG gradient — "the branch continues, commits in between" — stopping
 * short of the next row's dot (user 2026-07-04, replaced the dashed stub).
 *
 * Pure presentational, geometry only — the lane math lives in `graph.ts`.
 */
@Component({
  selector: 'git-graph-cell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    // overflow visible: lines OVERDRAW ±1.5px past the row so DPI-scaling
    // rounding between adjacent per-row SVGs can never open a gap (user
    // report 2026-07-03, 125%/150% Windows scaling).
    `:host { display: block; flex-shrink: 0; }
     svg { display: block; overflow: visible; }
     .lane--named { transition: stroke-width 0.12s ease; }
     .lane--named:hover { stroke-width: 3.5; }
     .lane--live { cursor: pointer; }
     .dot-hit { fill: currentColor; fill-opacity: 0; transition: fill-opacity 0.12s ease; }
     .dot-hit--live { cursor: pointer; }
     .dot-hit--live:hover { fill-opacity: 0.22; }`,
  ],
  template: `
    <svg [attr.width]="svgWidth()" [attr.height]="rowHeight">
      @if (row().dangling.length > 0) {
        <svg:defs>
          @for (k of row().dangling; track k) {
            <svg:linearGradient
              [attr.id]="fadeId(k)"
              gradientUnits="userSpaceOnUse"
              x1="0" [attr.y1]="mid" x2="0" [attr.y2]="stubEnd"
            >
              <svg:stop offset="0" [attr.stop-color]="edgeColor(k)" stop-opacity="1" />
              <svg:stop offset="0.5" [attr.stop-color]="edgeColor(k)" stop-opacity="0.7" />
              <svg:stop offset="1" [attr.stop-color]="edgeColor(k)" stop-opacity="0" />
            </svg:linearGradient>
          }
        </svg:defs>
      }
      @for (j of row().through; track j) {
        <svg:line
          [attr.x1]="cx(j)" [attr.y1]="-overlap" [attr.x2]="cx(j)" [attr.y2]="rowHeight + overlap"
          [attr.stroke]="throughColor(j)" stroke-width="2"
          [class.lane--named]="row().labels[j] !== undefined"
          [class.lane--live]="laneLive(j)"
          (click)="onLane(j, $event)"
        >
          @if (row().labels[j]; as label) {
            <svg:title>{{ label }}</svg:title>
          }
        </svg:line>
      }
      @for (j of row().fromTop; track j) {
        <svg:path
          [attr.d]="topPath(j)"
          [attr.stroke]="topColor(j)" stroke-width="2" fill="none"
        />
      }
      @for (k of row().toBottom; track k) {
        <svg:path
          [attr.d]="bottomPath(k)"
          [attr.stroke]="strokeOf(k)" stroke-width="2" fill="none"
          [class.lane--named]="row().labels[k] !== undefined"
          [class.lane--live]="laneLive(k)"
          (click)="onLane(k, $event)"
        >
          @if (row().labels[k]; as label) {
            <svg:title>{{ label }}</svg:title>
          }
        </svg:path>
      }
      @if (isTip()) {
        <!-- Branch tip: ringed dot so a line STARTING here reads as "a new
             branch begins", not as a floating commit (user 2026-07-03). -->
        <svg:circle
          [attr.cx]="cx(row().lane)" [attr.cy]="mid" r="5.5"
          fill="none" [attr.stroke]="dotColor()" stroke-width="2"
        />
        <svg:circle
          [attr.cx]="cx(row().lane)" [attr.cy]="mid" r="2.5"
          [attr.fill]="dotColor()"
        />
      } @else {
        <svg:circle
          [attr.cx]="cx(row().lane)" [attr.cy]="mid" r="4"
          [attr.fill]="dotColor()"
        />
      }
      <!-- Invisible hit circle: a 4px dot is unhoverable/unclickable — this
           carries the tooltip for every dot, and halo + click-to-filter for
           LIVE branches only (deleted merge-subject names are display-only:
           filtering a gone ref errors). -->
      <svg:circle
        [attr.cx]="cx(row().lane)" [attr.cy]="mid" r="9"
        class="dot-hit"
        [style.color]="dotColor()"
        [class.dot-hit--live]="row().label !== undefined"
        (click)="onDot($event)"
      >
        @if (row().label; as label) {
          <svg:title>{{ label }}</svg:title>
        }
      </svg:circle>
    </svg>
  `,
})
export class GraphCellComponent {
  private static nextUid = 0;

  readonly row = input.required<GraphRow>();
  /** Page-wide lane count so every row renders the same width. */
  readonly lanes = input.required<number>();
  /** Page palette: label → color (assignBranchColors, container-owned). */
  readonly palette = input<ReadonlyMap<string, string>>(new Map());
  /** Click on a live-branch LINE — the container filters to that branch. */
  readonly laneClicked = output<string>();
  /** Click on any labeled dot — the container resolves label vs sha. */
  readonly dotClicked = output<void>();

  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly mid = ROW_HEIGHT / 2;
  /** Vertical overdraw past the row bounds (kills DPI rounding gaps). */
  protected readonly overlap = 1.5;
  /** Fading dangling stubs end here (past the row edge, shy of the next dot). */
  protected readonly stubEnd = ROW_HEIGHT + STUB_OVERHANG;
  /** Gradient ids must be document-unique across cells. */
  private readonly uid = GraphCellComponent.nextUid++;

  protected readonly svgWidth = computed(() => this.lanes() * LANE_WIDTH);

  protected cx(lane: number): number {
    return lane * LANE_WIDTH + LANE_WIDTH / 2;
  }

  private colorFor(label: string | undefined, lane: number): string {
    return (label !== undefined && this.palette().get(label)) || laneColor(lane);
  }

  /** The commit's own line color (label identity, lane fallback). */
  protected dotColor(): string {
    return this.colorFor(this.row().label, this.row().lane);
  }

  protected throughColor(lane: number): string {
    return this.colorFor(this.row().labels[lane], lane);
  }

  protected topColor(lane: number): string {
    return this.colorFor(this.row().topLabels[lane], lane);
  }

  /**
   * toBottom edges take the TARGET lane's color: a fork connector wears the
   * SOURCE branch's color — "this line was cut from THAT branch" — and flows
   * into the child dot, where the new branch's color takes over (user
   * 2026-07-15: la costura debe ser naranja y desembocar en el punto verde).
   * Continuations and merge fan-outs read the same way: the lane below is
   * named (backfilled when the merge subject can't name it), so every color
   * change happens AT a dot, never mid-line.
   */
  protected edgeColor(lane: number): string {
    return this.colorFor(this.row().labels[lane] ?? this.row().label, lane);
  }

  protected fadeId(lane: number): string {
    return `gfade-${this.uid}-${lane}`;
  }

  /** Dangling edges stroke with their fade gradient; connected ones solid. */
  protected strokeOf(lane: number): string {
    return this.row().dangling.includes(lane)
      ? `url(#${this.fadeId(lane)})`
      : this.edgeColor(lane);
  }

  protected laneLive(lane: number): boolean {
    return this.row().labels[lane] !== undefined && this.row().labelsLive[lane] === true;
  }

  protected onLane(lane: number, event: Event): void {
    if (this.laneLive(lane)) {
      event.stopPropagation(); // don't open the row's commit detail
      this.laneClicked.emit(this.row().labels[lane] as string);
    }
  }

  protected onDot(event: Event): void {
    if (this.row().label !== undefined) {
      event.stopPropagation(); // don't open the row's commit detail
      this.dotClicked.emit();
    }
  }

  /** No line enters from above and it has parents → a branch's tip commit. */
  protected isTip(): boolean {
    return this.row().fromTop.length === 0 && this.row().toBottom.length > 0;
  }

  /** Rounded-elbow corner radius (clamped to the lane distance). */
  private radius(from: number, to: number): number {
    return Math.min(8, Math.abs(to - from));
  }

  /**
   * Line from the row top at lane `j` into the dot: straight down, then a
   * rounded 90° elbow into the dot's row. Elbows cross other lanes
   * PERPENDICULARLY — long diagonals read as spaghetti once several lanes
   * are active (user 2026-07-03, screenshot #5).
   */
  protected topPath(j: number): string {
    const x = this.cx(j);
    const xd = this.cx(this.row().lane);
    const top = -this.overlap;
    if (x === xd) {
      return `M ${x} ${top} L ${x} ${this.mid}`;
    }
    const r = this.radius(x, xd);
    const dir = xd > x ? 1 : -1;
    return `M ${x} ${top} L ${x} ${this.mid - r} Q ${x} ${this.mid} ${x + dir * r} ${this.mid} L ${xd} ${this.mid}`;
  }

  /** Elbow from the dot to the row bottom at lane `k` (mirrored geometry).
   *  Dangling edges run to `stubEnd`, fading via their gradient; connected
   *  edges overdraw slightly so adjacent rows always join. */
  protected bottomPath(k: number): string {
    const x = this.cx(k);
    const xd = this.cx(this.row().lane);
    const h = this.row().dangling.includes(k) ? this.stubEnd : this.rowHeight + this.overlap;
    if (x === xd) {
      return `M ${x} ${this.mid} L ${x} ${h}`;
    }
    const r = this.radius(xd, x);
    const dir = x > xd ? 1 : -1;
    if (this.row().through.includes(k)) {
      // Junction into a lane that already flows through this row: stop at
      // the curve — the through line owns the vertical below. Extending the
      // tail overdrew that line in THIS edge's color, then snapped back at
      // the next row's seam (user 2026-07-15: green tail on the orange line).
      return `M ${xd} ${this.mid} L ${x - dir * r} ${this.mid} Q ${x} ${this.mid} ${x} ${this.mid + r}`;
    }
    return `M ${xd} ${this.mid} L ${x - dir * r} ${this.mid} Q ${x} ${this.mid} ${x} ${this.mid + r} L ${x} ${h}`;
  }
}

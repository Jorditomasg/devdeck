/**
 * Repo card expand panel — presentational (inventory-gui.md §7). Rendered
 * LAZILY by the container (only after the first expand toggle, §7 "lazy
 * construction"). All text arrives translated through the row view-models /
 * {@link CardExpandText}; every interaction is an output.
 *
 * Rows (§7): branch + repo tools / per-module env selectors / java /
 * custom command / docker compose buttons. The log row (§8) is a sibling
 * component (`app-card-log`) — the container stacks them.
 */
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import {
  ButtonComponent,
  IconButtonComponent,
  SearchableSelectComponent,
  TooltipDirective,
} from '../../../ui';
import type { DockerBtnState } from './card-logic';

/**
 * One resolved action button (§7 row 1) — declared per type via YAML
 * `ui.actions` and mapped through the repo-card action registry. `command`
 * is the IPC command name the container invokes via {@link runAction}.
 */
export interface ActionBtnVm {
  readonly key: string;
  readonly icon: string;
  readonly label: string;
  readonly command: string;
}

/** Row 1 — branch + tools (§7 row 1). */
export interface BranchRowVm {
  readonly options: readonly string[];
  readonly recentCount: number;
  readonly value: string;
  readonly loaded: boolean;
  readonly inProfile: boolean;
  /** Pull button label (already includes the behind count when > 0). */
  readonly pullText: string;
  readonly pullActive: boolean;
  readonly showConfigBtn: boolean;
  readonly showInstallBtn: boolean;
  readonly installText: string;
  readonly installEnabled: boolean;
  readonly installTip: string;
  /** Declared action buttons (e.g. the docker-infra "Seed" button). */
  readonly actions: readonly ActionBtnVm[];
}

/** One env/app selector row (§7 row 2). */
export interface ModuleRowVm {
  readonly key: string;
  /** `"{prefix}:"` label (from ui_config.selectors[0].label). */
  readonly label: string;
  /** Module dir hint, only with >1 modules (`''` hides it). */
  readonly dirLabel: string;
  /** `[noSelection, ...sorted names]`. */
  readonly options: readonly string[];
  /** Display value (the no-selection sentinel when nothing active). */
  readonly value: string;
  readonly tracked: boolean;
  readonly danger: boolean;
  readonly managerTip: string;
}

/** Row 2b — java version (§7 row 2b); `null` hides the row. */
export interface JavaRowVm {
  readonly options: readonly string[];
  readonly value: string;
  /** Recommended-version hint; `''` hides it (only while on default). */
  readonly recommended: string;
}

/**
 * Row 3 — custom command (§7 row 3); `null` hides the row (docker-infra).
 * Reused by row 3b (start arguments) — same shape.
 */
export interface CmdRowVm {
  readonly value: string;
  readonly placeholder: string;
  readonly tip: string;
}

/** One docker compose file button (§7 row 3.5). */
export interface DockerBtnVm {
  readonly file: string;
  readonly name: string;
  readonly counts: string;
  readonly state: DockerBtnState;
  readonly tip: string;
}

/** Whole-panel view model, built by the container. */
export interface CardExpandVm {
  readonly branch: BranchRowVm;
  readonly modules: readonly ModuleRowVm[];
  readonly java: JavaRowVm | null;
  readonly cmd: CmdRowVm | null;
  /** Row 3b — start arguments; `null` hides the row (same rule as `cmd`). */
  readonly args: CmdRowVm | null;
  readonly docker: readonly DockerBtnVm[];
}

/** Static translated strings of the panel. */
export interface CardExpandText {
  readonly branchLabel: string;
  readonly reloadTip: string;
  readonly branchInProfileTip: string;
  readonly envInProfileTip: string;
  readonly pullTip: string;
  readonly mergeText: string;
  readonly mergeTip: string;
  readonly cleanText: string;
  readonly cleanTip: string;
  readonly stashText: string;
  readonly stashTip: string;
  readonly branchesText: string;
  readonly branchesTip: string;
  readonly configText: string;
  readonly configTip: string;
  readonly javaLabel: string;
  readonly cmdLabel: string;
  readonly applyText: string;
  readonly applyTip: string;
  readonly resetText: string;
  readonly resetTip: string;
  readonly argsLabel: string;
  readonly applyArgsTip: string;
  readonly resetArgsTip: string;
  readonly searchPlaceholder: string;
  readonly noResultsText: string;
}

@Component({
  selector: 'app-card-expand',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    IconButtonComponent,
    SearchableSelectComponent,
    TooltipDirective,
  ],
  styleUrl: './card-expand.component.scss',
  template: `
    <!-- Row 1 — branch + repo tools (§7 row 1) -->
    <div class="row">
      <span class="row__label">{{ text().branchLabel }}</span>
      <ui-searchable-select
        class="row__branch"
        [options]="vm().branch.options"
        [recentCount]="vm().branch.recentCount"
        [value]="vm().branch.value"
        [disabled]="!vm().branch.loaded"
        [searchPlaceholder]="text().searchPlaceholder"
        [noResultsText]="text().noResultsText"
        (selectionChange)="branchSelected.emit($event)"
      />
      <ui-icon-button
        variant="log-action"
        [uiTooltip]="text().reloadTip"
        (clicked)="reload.emit()"
      >🔄</ui-icon-button>
      <label class="row__check" [uiTooltip]="text().branchInProfileTip">
        <input
          type="checkbox"
          [checked]="vm().branch.inProfile"
          (change)="branchInProfileChange.emit($any($event.target).checked)"
        />
      </label>
      <ui-button
        [variant]="vm().branch.pullActive ? 'blue-active' : 'blue'"
        [uiTooltip]="text().pullTip"
        (clicked)="pull.emit()"
      >{{ vm().branch.pullText }}</ui-button>
      <ui-button variant="purple-alt" [uiTooltip]="text().mergeTip" (clicked)="merge.emit()">
        {{ text().mergeText }}
      </ui-button>
      <ui-button variant="purple" [uiTooltip]="text().cleanTip" (clicked)="clean.emit()">
        {{ text().cleanText }}
      </ui-button>
      <ui-button variant="purple-alt" [uiTooltip]="text().stashTip" (clicked)="stash.emit()">
        {{ text().stashText }}
      </ui-button>
      <ui-button variant="purple-alt" [uiTooltip]="text().branchesTip" (clicked)="branches.emit()">
        {{ text().branchesText }}
      </ui-button>
      @if (vm().branch.showConfigBtn) {
        <ui-button variant="neutral" [uiTooltip]="text().configTip" (clicked)="openConfig.emit()">
          {{ text().configText }}
        </ui-button>
      }
      @for (action of vm().branch.actions; track action.key) {
        <ui-button
          variant="purple-global"
          [uiTooltip]="action.label"
          (clicked)="runAction.emit(action.command)"
        >
          {{ action.icon }} {{ action.label }}
        </ui-button>
      }
      <span class="row__spacer"></span>
      @if (vm().branch.showInstallBtn) {
        <ui-button
          variant="neutral-alt"
          [disabled]="!vm().branch.installEnabled"
          [uiTooltip]="vm().branch.installTip"
          (clicked)="install.emit()"
        >{{ vm().branch.installText }}</ui-button>
      }
    </div>

    <!-- Row 2 — env/app selectors, one per module (§7 row 2) -->
    @for (module of vm().modules; track module.key) {
      <div class="row">
        <span class="row__label">{{ module.label }}</span>
        <ui-searchable-select
          class="row__config"
          [class.row__config--danger]="module.danger"
          [options]="module.options"
          [value]="module.value"
          [searchPlaceholder]="text().searchPlaceholder"
          [noResultsText]="text().noResultsText"
          (selectionChange)="configSelected.emit({ moduleKey: module.key, value: $event })"
        />
        <ui-icon-button
          variant="neutral"
          [uiTooltip]="module.managerTip"
          (clicked)="openConfigManager.emit(module.key)"
        >⚙</ui-icon-button>
        <label class="row__check" [uiTooltip]="text().envInProfileTip">
          <input
            type="checkbox"
            [checked]="module.tracked"
            (change)="
              moduleTrackedChange.emit({
                moduleKey: module.key,
                tracked: $any($event.target).checked
              })
            "
          />
        </label>
        @if (module.dirLabel) {
          <span class="row__dir">{{ module.dirLabel }}</span>
        }
      </div>
    }

    <!-- Row 2b — java version (§7 row 2b) -->
    @if (vm().java; as java) {
      <div class="row">
        <span class="row__label">{{ text().javaLabel }}</span>
        <ui-searchable-select
          class="row__java"
          [options]="java.options"
          [value]="java.value"
          [searchPlaceholder]="text().searchPlaceholder"
          [noResultsText]="text().noResultsText"
          (selectionChange)="javaSelected.emit($event)"
        />
        @if (java.recommended) {
          <span class="row__recommended">{{ java.recommended }}</span>
        }
      </div>
    }

    <!-- Row 3 — custom command (§7 row 3) -->
    @if (vm().cmd; as cmd) {
      <div class="row">
        <span class="row__label">{{ text().cmdLabel }}</span>
        <input
          #cmdInput
          class="row__cmd"
          type="text"
          [value]="cmd.value"
          [placeholder]="cmd.placeholder"
          [uiTooltip]="cmd.tip"
          (keydown.enter)="commandApply.emit(cmdInput.value)"
        />
        <ui-button
          variant="success"
          size="sm"
          [uiTooltip]="text().applyTip"
          (clicked)="commandApply.emit(cmdInput.value)"
        >{{ text().applyText }}</ui-button>
        <ui-button
          variant="neutral"
          size="sm"
          [uiTooltip]="text().resetTip"
          (clicked)="cmdInput.value = ''; commandReset.emit()"
        >{{ text().resetText }}</ui-button>
      </div>
    }

    <!-- Row 3b — start arguments (§7 row 3b) -->
    @if (vm().args; as args) {
      <div class="row">
        <span class="row__label">{{ text().argsLabel }}</span>
        <input
          #argsInput
          class="row__cmd"
          type="text"
          [value]="args.value"
          [placeholder]="args.placeholder"
          [uiTooltip]="args.tip"
          (keydown.enter)="argsApply.emit(argsInput.value)"
        />
        <ui-button
          variant="success"
          size="sm"
          [uiTooltip]="text().applyArgsTip"
          (clicked)="argsApply.emit(argsInput.value)"
        >{{ text().applyText }}</ui-button>
        <ui-button
          variant="neutral"
          size="sm"
          [uiTooltip]="text().resetArgsTip"
          (clicked)="argsInput.value = ''; argsReset.emit()"
        >{{ text().resetText }}</ui-button>
      </div>
    }

    <!-- Row 3.5 — docker compose buttons (§7 row 3.5) -->
    @if (vm().docker.length > 0) {
      <div class="row row--docker">
        @for (btn of vm().docker; track btn.file) {
          <button
            type="button"
            class="docker-btn docker-btn--{{ btn.state }}"
            [uiTooltip]="btn.tip"
            (click)="dockerFileClicked.emit(btn.file)"
          >
            🐳 {{ btn.name }} {{ btn.counts }}
          </button>
        }
      </div>
    }
  `,
})
export class CardExpandComponent {
  readonly vm = input.required<CardExpandVm>();
  readonly text = input.required<CardExpandText>();

  readonly branchSelected = output<string>();
  readonly reload = output<void>();
  readonly branchInProfileChange = output<boolean>();
  readonly pull = output<void>();
  readonly merge = output<void>();
  readonly clean = output<void>();
  readonly stash = output<void>();
  readonly branches = output<void>();
  readonly openConfig = output<void>();
  readonly install = output<void>();
  /** Run a declared per-type action; payload is the IPC command name. */
  readonly runAction = output<string>();
  readonly configSelected = output<{ moduleKey: string; value: string }>();
  readonly openConfigManager = output<string>();
  readonly moduleTrackedChange = output<{ moduleKey: string; tracked: boolean }>();
  readonly javaSelected = output<string>();
  readonly commandApply = output<string>();
  readonly commandReset = output<void>();
  readonly argsApply = output<string>();
  readonly argsReset = output<void>();
  readonly dockerFileClicked = output<string>();
}

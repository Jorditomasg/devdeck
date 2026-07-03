import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  input,
  viewChild,
} from '@angular/core';

import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';

import { languageFor } from './language-by-extension';

/**
 * Read-only CodeMirror 6 host (git suite phase 1): renders full file
 * contents at a commit with language highlighting picked by extension.
 * Phase 4 reuses the same CodeMirror integration for the conflict editor.
 * Pure presentational — plain `content`/`fileName` inputs, no core imports.
 */
@Component({
  selector: 'ui-code-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './code-view.component.scss',
  template: `<div class="code__host" #host></div>`,
})
export class CodeViewComponent implements OnDestroy {
  readonly content = input('');
  /** Used only to pick the highlight language (extension). */
  readonly fileName = input('');

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private view: EditorView | null = null;

  constructor() {
    // Rebuild the editor state whenever content/file change — cheaper and
    // simpler than incremental dispatch for a read-only viewer.
    effect(() => {
      const doc = this.content();
      const language = languageFor(this.fileName());
      const parent = this.host().nativeElement;

      const extensions: Extension[] = [
        lineNumbers(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      ];
      if (language) {
        extensions.push(language);
      }
      const state = EditorState.create({ doc, extensions });
      if (this.view) {
        this.view.setState(state);
      } else {
        this.view = new EditorView({ state, parent });
      }
    });
  }

  ngOnDestroy(): void {
    this.view?.destroy();
    this.view = null;
  }
}

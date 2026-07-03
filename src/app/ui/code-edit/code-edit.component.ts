import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';

import { languageFor } from '../code-view/language-by-extension';

/**
 * EDITABLE CodeMirror 6 host (changes window, design doc 2026-07-03) — the
 * writing sibling of `ui-code-view`. Same direct-import rule: consumers
 * import this file, never the `ui` barrel (initial-bundle budget).
 *
 * State contract: the editor rebuilds ONLY when the incoming `content`
 * differs from the live document — the container echoing the draft back
 * (dirty tracking, save) never resets the cursor or the undo history.
 * Pure presentational: emits every edit + Mod-s; the container owns saving.
 */
@Component({
  selector: 'ui-code-edit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './code-edit.component.scss',
  template: `<div class="code__host" #host></div>`,
})
export class CodeEditComponent implements OnDestroy {
  readonly content = input('');
  /** Used only to pick the highlight language (extension). */
  readonly fileName = input('');

  /** Fires on EVERY document edit with the full new text. */
  readonly contentChanged = output<string>();
  /** Mod-s pressed inside the editor — the container saves. */
  readonly saveRequested = output<void>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private view: EditorView | null = null;
  private fileKey = '';

  constructor() {
    effect(() => {
      const doc = this.content();
      const file = this.fileName();
      const parent = this.host().nativeElement;

      // Same file + same text as the live doc → nothing to do (echo of our
      // own contentChanged). Different file → full rebuild (fresh history).
      if (this.view && file === this.fileKey) {
        if (doc !== this.view.state.doc.toString()) {
          this.view.setState(this.buildState(doc, file));
        }
        return;
      }
      this.fileKey = file;
      const state = this.buildState(doc, file);
      if (this.view) {
        this.view.setState(state);
      } else {
        this.view = new EditorView({ state, parent });
      }
    });
  }

  private buildState(doc: string, file: string): EditorState {
    const extensions: Extension[] = [
      lineNumbers(),
      history(),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            this.saveRequested.emit();
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          this.contentChanged.emit(update.state.doc.toString());
        }
      }),
    ];
    const language = languageFor(file);
    if (language) {
      extensions.push(language);
    }
    return EditorState.create({ doc, extensions });
  }

  ngOnDestroy(): void {
    this.view?.destroy();
    this.view = null;
  }
}

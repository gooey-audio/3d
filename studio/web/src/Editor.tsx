import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { Compartment, EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type { CadError } from "./api";

type Props = {
  /** Changes when a new document should replace the editor's (part switch, external edit). */
  docKey: string;
  doc: string;
  readOnly: boolean;
  error: CadError | null;
  onChange: (text: string) => void;
  onSave: () => void;
};

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px" },
  ".cm-scroller": { fontFamily: "ui-monospace, 'JetBrains Mono', Menlo, monospace" },
});

export function Editor({ docKey, doc, readOnly, error, onChange, onSave }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const ro = useRef(new Compartment());
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc,
        extensions: [
          basicSetup,
          javascript(),
          lintGutter(),
          oneDark,
          theme,
          ro.current.of(EditorState.readOnly.of(readOnly)),
          keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) }]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((t) => t.annotation(external))) {
              cb.current.onChange(u.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new document from outside: replace the text, keep the cursor where possible.
  useEffect(() => {
    const v = view.current!;
    if (v.state.doc.toString() === doc) return;
    const head = Math.min(v.state.selection.main.head, doc.length);
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: doc },
      selection: { anchor: head },
      annotations: external.of(true),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  useEffect(() => {
    view.current!.dispatch({ effects: ro.current.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly]);

  // Build errors as diagnostics at their script line.
  useEffect(() => {
    const v = view.current!;
    const diags: Diagnostic[] = [];
    if (error) {
      const lines = v.state.doc.lines;
      const ln = error.line && error.line <= lines ? error.line : 1;
      const line = v.state.doc.line(ln);
      const from = Math.min(line.from + Math.max(0, (error.column ?? 1) - 1), line.to);
      diags.push({
        from: error.line ? from : 0,
        to: error.line ? line.to : 0,
        severity: "error",
        message: `${error.kind}: ${error.message}`,
      });
    }
    v.dispatch(setDiagnostics(v.state, diags));
  }, [error, docKey]);

  return <div className="editor" ref={host} />;
}

import { Annotation } from "@codemirror/state";
const external = Annotation.define<boolean>();

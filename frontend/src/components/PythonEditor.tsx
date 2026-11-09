import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

const theme = EditorView.theme({
  "&": { color: "var(--foreground)", backgroundColor: "var(--background)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", fontSize: "0.75rem", lineHeight: "1.65", maxHeight: "55vh" },
  ".cm-content": { padding: "0.75rem 0", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0 0.75rem" },
  ".cm-gutters": { color: "var(--muted-foreground)", backgroundColor: "var(--card)", borderColor: "var(--border)" },
});

const highlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: "var(--loss)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--gain)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--warning)" },
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [tags.className, tags.function(tags.definition(tags.variableName))], fontWeight: "600" },
]));

export default function PythonEditor({ code, onChange, label }: {
  code: string;
  onChange?: (code: string) => void;
  label: string;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const settings = useRef(new Compartment());
  const current = useRef({ code, onChange });
  current.current = { code, onChange };

  useEffect(() => {
    const editor = new EditorView({
      parent: parent.current!,
      doc: current.current.code,
      extensions: [
        theme, python(), highlighting, lineNumbers(), history(), indentOnInput(), bracketMatching(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        settings.current.of([]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const next = update.state.doc.toString();
          if (next !== current.current.code) current.current.onChange?.(next);
        }),
      ],
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, []);

  const readOnly = !onChange;
  useEffect(() => {
    view.current?.dispatch({ effects: settings.current.reconfigure([
      EditorState.readOnly.of(readOnly),
      EditorView.contentAttributes.of({ "aria-label": label }),
    ]) });
  }, [label, readOnly]);

  useEffect(() => {
    const editor = view.current;
    if (editor && code !== editor.state.doc.toString()) {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: code },
        annotations: Transaction.addToHistory.of(false),
      });
    }
  }, [code]);

  return <div ref={parent} className="min-w-0 overflow-hidden rounded-lg border border-input focus-within:ring-2 focus-within:ring-ring" />;
}

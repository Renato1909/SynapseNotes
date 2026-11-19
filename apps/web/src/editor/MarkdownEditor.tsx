// Editor Markdown: CodeMirror 6 ligado ao Y.Text('markdown') do provedor,
// com seleções remotas e undo gerenciado pelo Y.UndoManager (não pelo
// history do CodeMirror, que registraria edições remotas).

import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder
} from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { yCollab } from 'y-codemirror.next';
import { useEffect, useRef } from 'react';
import type { CollabProvider } from '../collab/provider.ts';

interface MarkdownEditorProps {
  provider: CollabProvider;
  editable: boolean;
}

// Fica em uma Compartment para alternar leitura/escrita sem recriar a view
// (recriar geraria um novo UndoManager e perderia o histórico).
function editableExtensions(editable: boolean) {
  return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)];
}

export function MarkdownEditor({ provider, editable }: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editableCompartment = useRef(new Compartment());

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const ytext = provider.doc.getText('markdown');
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        // Semente sincronizada com o Y.Text; o ySync ajusta depois.
        doc: ytext.toString(),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          // Sem history(): o Ctrl+Z cai no yUndoManagerKeymap do yCollab,
          // que só desfaz edições locais deste usuário.
          keymap.of([...defaultKeymap, ...searchKeymap, indentWithTab]),
          markdown(),
          oneDark,
          editableCompartment.current.of(editableExtensions(editable)),
          placeholder('Escreva em Markdown...'),
          EditorView.lineWrapping,
          yCollab(ytext, provider.awareness)
        ]
      })
    });

    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // O view é criado uma única vez por provedor; leitura/escrita é
    // alternada pela Compartment no efeito abaixo.
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableCompartment.current.reconfigure(editableExtensions(editable))
    });
  }, [editable]);

  return <div className="markdown-editor" ref={hostRef} />;
}

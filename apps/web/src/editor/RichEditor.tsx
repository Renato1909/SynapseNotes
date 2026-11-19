// Editor de texto rico: TipTap ligado ao Y.XmlFragment do provedor, com
// cursores e seleções remotas via CollaborationCaret.

import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useEffect } from 'react';
import type { CollabProvider } from '../collab/provider.ts';
import { baseExtensions, RICH_FRAGMENT_FIELD } from './extensions.ts';

export interface LocalUser {
  id: number;
  name: string;
  color: string;
}

interface RichEditorProps {
  provider: CollabProvider;
  user: LocalUser;
  editable: boolean;
  // Devolve a instância ao EditorPage para a barra de formatação e para a
  // conversão de modo (rico -> Markdown).
  onEditor: (editor: Editor | null) => void;
}

export function RichEditor({ provider, user, editable, onEditor }: RichEditorProps) {
  const editor = useEditor(
    {
      extensions: [
        ...baseExtensions,
        Collaboration.configure({
          document: provider.doc,
          field: RICH_FRAGMENT_FIELD
        }),
        CollaborationCaret.configure({
          // O provedor expõe a mesma Awareness usada em todo o app.
          provider,
          user
        })
      ],
      editable
    },
    [provider]
  );

  useEffect(() => {
    onEditor(editor);
    return () => onEditor(null);
  }, [editor, onEditor]);

  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);

  return (
    <div className="rich-editor">
      <EditorContent editor={editor} />
    </div>
  );
}

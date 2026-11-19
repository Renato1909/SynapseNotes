// Extensões TipTap compartilhadas entre o editor rico e a geração de
// schema usada na conversão de Markdown. Collaboration e CollaborationCaret
// ficam de fora aqui porque dependem do Y.Doc/provedor em tempo de execução.

import { getSchema } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import StarterKit from '@tiptap/starter-kit';
import type { Schema } from 'prosemirror-model';

// Nome do Y.XmlFragment que guarda o conteúdo rico. Precisa ser o mesmo no
// Collaboration (TipTap) e na conversão de modo no EditorPage.
export const RICH_FRAGMENT_FIELD = 'default';

export const baseExtensions = [
  StarterKit.configure({
    // O histórico é gerenciado pelo Y.UndoManager (Collaboration);
    // manter o undoRedo do StarterKit causaria conflito.
    undoRedo: false
  }),
  Placeholder.configure({
    placeholder: 'Comece a escrever...'
  }),
  Image.configure({
    allowBase64: false
  })
];

let cachedSchema: Schema | null = null;

// Schema canônico do TipTap: permite transformar Markdown em documento
// ProseMirror sem precisar de um editor montado (ex.: ao voltar para o
// modo rico, quando nenhum editor TipTap está na tela).
export function getTipTapSchema(): Schema {
  cachedSchema ??= getSchema(baseExtensions);
  return cachedSchema;
}

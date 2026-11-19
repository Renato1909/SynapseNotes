// Página da nota: conecta o provedor de colaboração, mostra a barra de
// formatação (modo rico) e alterna entre os editores rico/Markdown com
// conversão de conteúdo.

import type { Editor } from '@tiptap/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { api, ApiError, type NoteSummary } from '../api.ts';
import { useAuth } from '../app.tsx';
import { navigate } from '../router.ts';
import { CollabProvider, type ProviderStatus } from '../collab/provider.ts';
import { PresenceBar } from '../components/PresenceBar.tsx';
import { ShareDialog } from '../components/ShareDialog.tsx';
import { MarkdownEditor } from '../editor/MarkdownEditor.tsx';
import { RichEditor, type LocalUser } from '../editor/RichEditor.tsx';
import { getTipTapSchema, RICH_FRAGMENT_FIELD } from '../editor/extensions.ts';
import { markdownToRichDoc, richToMarkdownText } from '../editor/markdown-convert.ts';

const AVATAR_COLORS = ['#f87171', '#fb923c', '#fbbf24', '#4ade80', '#22d3ee', '#6ea8fe', '#a78bfa', '#f472b6'];

type NoteMode = 'rich' | 'markdown';

interface EditorPageProps {
  noteId: string;
}

export function EditorPage({ noteId }: EditorPageProps) {
  const { user } = useAuth();
  const [note, setNote] = useState<NoteSummary | null>(null);
  const [loadError, setLoadError] = useState('');
  const [mode, setMode] = useState<NoteMode>('rich');
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<ProviderStatus>('connecting');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [provider, setProvider] = useState<CollabProvider | null>(null);
  const [, setTick] = useState(0);

  // Um evento de controle do servidor (hello/mode-changed) tem precedência
  // sobre o modo devolvido pela REST, que pode estar desatualizado.
  const modeFromServer = useRef(false);
  const forceRender = useCallback(() => setTick((tick) => tick + 1), []);

  // Provedor de colaboração (criado uma vez por página).
  useEffect(() => {
    const collab = new CollabProvider(noteId);
    const offStatus = collab.on('status', setStatus);
    const offControl = collab.on('control', (event) => {
      if (event.event === 'hello' || event.event === 'mode-changed') {
        modeFromServer.current = true;
        setMode(event.mode);
      }
      if (event.event === 'error') setNotice(event.message);
    });
    setProvider(collab);
    collab.connect();
    return () => {
      offStatus();
      offControl();
      collab.destroy();
      setProvider(null);
    };
  }, [noteId]);

  // Metadados da nota (papel, modo inicial, título).
  useEffect(() => {
    let cancelled = false;
    api
      .getNote(noteId)
      .then(({ note: loaded }) => {
        if (cancelled) return;
        setNote(loaded);
        setTitle(loaded.title);
        if (!modeFromServer.current) setMode(loaded.mode);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : 'Falha ao carregar a nota.');
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  // Presença: anuncia este usuário na Awareness (usada por cursores e
  // seleções remotas nos dois modos de edição).
  const localUser = useMemo<LocalUser | null>(
    () =>
      user
        ? {
            id: user.id,
            name: user.name,
            color: AVATAR_COLORS[user.id % AVATAR_COLORS.length] ?? '#6ea8fe'
          }
        : null,
    [user]
  );

  useEffect(() => {
    if (provider && localUser) provider.setLocalUser(localUser);
  }, [provider, localUser]);

  // Re-renderiza a barra de formatação a cada transação (para os estados
  // ativos de negrito, títulos etc.).
  useEffect(() => {
    if (!editor) return;
    editor.on('transaction', forceRender);
    return () => {
      editor.off('transaction', forceRender);
    };
  }, [editor, forceRender]);

  const canEdit = note !== null && note.role !== 'viewer';
  const isOwner = note?.role === 'owner';

  function persistTitle(): void {
    if (!note || note.role === 'viewer') return;
    const trimmed = title.trim();
    if (!trimmed) {
      setTitle(note.title);
      return;
    }
    if (trimmed === note.title) return;
    api
      .updateNote(noteId, { title: trimmed })
      .then(({ note: updated }) => setNote(updated))
      .catch(() => setNotice('Não foi possível salvar o título.'));
  }

  // Alterna entre rico e Markdown convertendo o conteúdo de um formato para
  // o outro ANTES de avisar o servidor; o broadcast `mode-changed` leva os
  // demais clientes para o mesmo modo.
  async function switchMode(target: NoteMode): Promise<void> {
    if (!provider || !note || busy || mode === target || !canEdit) return;
    setBusy(true);
    setNotice('');
    try {
      const fragment = provider.doc.getXmlFragment(RICH_FRAGMENT_FIELD);
      if (target === 'markdown') {
        // Rico -> Markdown: serializa o fragmento (fonte de verdade) e
        // substitui o Y.Text de markdown de uma vez só.
        const richDoc = yXmlFragmentToProseMirrorRootNode(fragment, getTipTapSchema());
        const text = richToMarkdownText(richDoc);
        const ytext = provider.doc.getText('markdown');
        provider.doc.transact(() => {
          if (ytext.length > 0) ytext.delete(0, ytext.length);
          if (text) ytext.insert(0, text);
        });
      } else {
        // Markdown -> rico: analisa o Y.Text e reescreve o fragmento
        // (updateYFragment faz o diff dentro de uma transação Yjs).
        const ytext = provider.doc.getText('markdown');
        prosemirrorToYXmlFragment(markdownToRichDoc(ytext.toString()), fragment);
      }
      await api.changeMode(noteId, target);
      setMode(target);
      setNote({ ...note, mode: target });
    } catch (err: unknown) {
      setNotice(err instanceof ApiError ? err.message : 'Falha ao trocar o modo da nota.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="editor-layout">
      <div className="editor-toolbar">
        <button className="btn btn-ghost btn-small" onClick={() => navigate('/notes')}>
          ‹ Notas
        </button>
        <input
          className="title-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={persistTitle}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          placeholder="Sem título"
          maxLength={120}
          disabled={!note || !canEdit}
        />
        <div className="mode-toggle">
          <button
            type="button"
            className={mode === 'rich' ? 'active' : ''}
            disabled={busy || !canEdit}
            onClick={() => void switchMode('rich')}
          >
            Texto
          </button>
          <button
            type="button"
            className={mode === 'markdown' ? 'active' : ''}
            disabled={busy || !canEdit}
            onClick={() => void switchMode('markdown')}
          >
            Markdown
          </button>
        </div>
        {provider && <PresenceBar awareness={provider.awareness} />}
        <span className={`conn-status ${status}`}>{statusLabel(status)}</span>
        {isOwner && (
          <button className="btn btn-ghost btn-small" onClick={() => setShowShare(true)}>
            Compartilhar
          </button>
        )}
      </div>

      {mode === 'rich' && editor && <FormatToolbar editor={editor} disabled={!canEdit} />}

      {notice && (
        <div className="error-box" style={{ margin: '8px 16px' }}>
          {notice}
        </div>
      )}

      <div className="editor-body">
        {loadError ? (
          <div className="page">
            <div className="error-box">{loadError}</div>
            <button className="btn" onClick={() => navigate('/notes')}>
              Voltar para notas
            </button>
          </div>
        ) : note && provider && localUser ? (
          mode === 'rich' ? (
            <RichEditor provider={provider} user={localUser} editable={canEdit} onEditor={setEditor} />
          ) : (
            <MarkdownEditor provider={provider} editable={canEdit} />
          )
        ) : (
          <div className="loading-page">Carregando nota...</div>
        )}
      </div>

      {showShare && note && <ShareDialog note={note} onClose={() => setShowShare(false)} />}
    </div>
  );
}

// ---------- Barra de formatação (somente modo rico) ----------

interface ToolbarAction {
  label: string;
  title: string;
  active?: (editor: Editor) => boolean;
  run: (editor: Editor) => void;
}

function insertLink(editor: Editor): void {
  const href = window.prompt('URL do link:');
  if (href === null) return;
  const trimmed = href.trim();
  if (trimmed === '') editor.chain().focus().unsetLink().run();
  else editor.chain().focus().toggleLink({ href: trimmed }).run();
}

function insertImage(editor: Editor): void {
  const src = window.prompt('URL da imagem:');
  if (!src || !src.trim()) return;
  editor.chain().focus().setImage({ src: src.trim() }).run();
}

const RICH_ACTIONS: ToolbarAction[] = [
  { label: 'H1', title: 'Título 1', active: (e) => e.isActive('heading', { level: 1 }), run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { label: 'H2', title: 'Título 2', active: (e) => e.isActive('heading', { level: 2 }), run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { label: 'H3', title: 'Título 3', active: (e) => e.isActive('heading', { level: 3 }), run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { label: 'B', title: 'Negrito', active: (e) => e.isActive('bold'), run: (e) => e.chain().focus().toggleBold().run() },
  { label: 'I', title: 'Itálico', active: (e) => e.isActive('italic'), run: (e) => e.chain().focus().toggleItalic().run() },
  { label: 'S', title: 'Tachado', active: (e) => e.isActive('strike'), run: (e) => e.chain().focus().toggleStrike().run() },
  { label: '</>', title: 'Código inline', active: (e) => e.isActive('code'), run: (e) => e.chain().focus().toggleCode().run() },
  { label: '•', title: 'Lista', active: (e) => e.isActive('bulletList'), run: (e) => e.chain().focus().toggleBulletList().run() },
  { label: '1.', title: 'Lista numerada', active: (e) => e.isActive('orderedList'), run: (e) => e.chain().focus().toggleOrderedList().run() },
  { label: '❝', title: 'Citação', active: (e) => e.isActive('blockquote'), run: (e) => e.chain().focus().toggleBlockquote().run() },
  { label: '---', title: 'Linha horizontal', run: (e) => e.chain().focus().setHorizontalRule().run() },
  { label: '🔗', title: 'Link', run: insertLink },
  { label: '🖼', title: 'Imagem', run: insertImage },
  { label: '↶', title: 'Desfazer', run: (e) => e.chain().focus().undo().run() },
  { label: '↷', title: 'Refazer', run: (e) => e.chain().focus().redo().run() }
];

function FormatToolbar({ editor, disabled }: { editor: Editor; disabled: boolean }) {
  return (
    <div className="editor-toolbar format-toolbar">
      {RICH_ACTIONS.map((action) => (
        <button
          key={action.title}
          type="button"
          className={`btn btn-ghost btn-small${action.active?.(editor) ? ' active' : ''}`}
          title={action.title}
          disabled={disabled}
          // Mantém o foco no editor ao clicar nos botões.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => action.run(editor)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

function statusLabel(status: ProviderStatus): string {
  if (status === 'connected') return 'Conectado';
  if (status === 'connecting') return 'Conectando...';
  return 'Desconectado';
}

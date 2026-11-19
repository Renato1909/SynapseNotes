import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type NoteSummary } from '../api.ts';
import { useAuth } from '../app.tsx';
import { navigate } from '../router.ts';
import { ShareDialog } from '../components/ShareDialog.tsx';

export function NotesListPage() {
  const { user, setUser } = useAuth();
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [shareNote, setShareNote] = useState<NoteSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.listNotes();
      setNotes(result.notes);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao carregar as notas.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    setCreating(true);
    setError('');
    try {
      const result = await api.createNote({ title: 'Sem titulo' });
      navigate(`/notes/${result.note.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao criar a nota.');
      setCreating(false);
    }
  }

  async function handleDelete(note: NoteSummary, event: React.MouseEvent) {
    event.stopPropagation();
    if (!window.confirm(`Excluir "${note.title}"? Esta acao nao pode ser desfeita.`)) return;
    try {
      await api.deleteNote(note.id);
      setNotes((current) => current.filter((item) => item.id !== note.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao excluir.');
    }
  }

  async function handleLogout() {
    try {
      await api.logout();
    } finally {
      setUser(null);
      navigate('/login');
    }
  }

  return (
    <>
      <header className="app-header">
        <div className="brand" onClick={() => navigate('/notes')}>
          Synapse<span>Notes</span>
        </div>
        <div className="spacer" />
        <span className="muted">{user?.name}</span>
        <button className="btn btn-ghost btn-small" onClick={() => void handleLogout()}>
          Sair
        </button>
      </header>

      <main className="page">
        <div className="notes-header">
          <h1>Suas notas</h1>
          <button className="btn" onClick={() => void handleCreate()} disabled={creating}>
            {creating ? 'Criando...' : '+ Nova nota'}
          </button>
        </div>

        {error && <div className="error-box">{error}</div>}

        {loading ? (
          <p className="muted">Carregando notas...</p>
        ) : notes.length === 0 ? (
          <div className="empty-state">
            <p>Nenhuma nota ainda.</p>
            <p className="muted">Crie sua primeira nota e convide pessoas para editar junto.</p>
          </div>
        ) : (
          <div className="notes-grid">
            {notes.map((note) => (
              <div
                key={note.id}
                className="note-card"
                onClick={() => navigate(`/notes/${note.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') navigate(`/notes/${note.id}`);
                }}
              >
                <h3>{note.title}</h3>
                <div className="meta">
                  <span className={`badge ${note.role}`}>{roleLabel(note.role)}</span>
                  <span className="badge">{note.mode === 'rich' ? 'Texto' : 'Markdown'}</span>
                  <span className="spacer" />
                  <span>{formatDate(note.updatedAt)}</span>
                </div>
                <div className="row">
                  <button
                    className="btn btn-ghost btn-small"
                    onClick={(event) => {
                      event.stopPropagation();
                      setShareNote(note);
                    }}
                    disabled={note.role !== 'owner'}
                    title={note.role !== 'owner' ? 'Apenas o dono pode compartilhar' : 'Compartilhar'}
                  >
                    Compartilhar
                  </button>
                  <span className="spacer" />
                  {note.role === 'owner' && (
                    <button
                      className="btn btn-danger btn-small"
                      onClick={(event) => void handleDelete(note, event)}
                    >
                      Excluir
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {shareNote && <ShareDialog note={shareNote} onClose={() => setShareNote(null)} />}
    </>
  );
}

function roleLabel(role: NoteSummary['role']): string {
  if (role === 'owner') return 'Dono';
  if (role === 'editor') return 'Editor';
  return 'Leitor';
}

function formatDate(value: string): string {
  const date = new Date(value.endsWith('Z') || value.includes('+') ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

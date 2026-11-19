import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type NoteMember, type NoteSummary } from '../api.ts';
import { useAuth } from '../app.tsx';

interface ShareDialogProps {
  note: NoteSummary;
  onClose: () => void;
}

export function ShareDialog({ note, onClose }: ShareDialogProps) {
  const { user } = useAuth();
  const [members, setMembers] = useState<NoteMember[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const result = await api.listMembers(note.id);
      setMembers(result.members);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao carregar membros.');
    } finally {
      setLoading(false);
    }
  }, [note.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.addMember(note.id, { email: email.trim(), role });
      setEmail('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao adicionar membro.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRoleChange(member: NoteMember, newRole: 'editor' | 'viewer') {
    setError('');
    try {
      await api.updateMember(note.id, member.user.id, newRole);
      setMembers((current) =>
        current.map((item) => (item.user.id === member.user.id ? { ...item, role: newRole } : item))
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao alterar papel.');
    }
  }

  async function handleRemove(member: NoteMember) {
    setError('');
    try {
      await api.removeMember(note.id, member.user.id);
      setMembers((current) => current.filter((item) => item.user.id !== member.user.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao remover membro.');
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <h2>Compartilhar "{note.title}"</h2>

        {error && <div className="error-box">{error}</div>}

        {loading ? (
          <p className="muted">Carregando membros...</p>
        ) : (
          <div>
            <div className="member-row">
              <div className="member-info">
                <div className="name">{user?.name} (voce)</div>
                <div className="email">{user?.email}</div>
              </div>
              <span className="badge owner">Dono</span>
            </div>
            {members.map((member) => (
              <div className="member-row" key={member.user.id}>
                <div className="member-info">
                  <div className="name">{member.user.name}</div>
                  <div className="email">{member.user.email}</div>
                </div>
                <select
                  value={member.role}
                  onChange={(event) =>
                    void handleRoleChange(member, event.target.value as 'editor' | 'viewer')
                  }
                >
                  <option value="editor">Editor</option>
                  <option value="viewer">Leitor</option>
                </select>
                <button className="btn btn-danger btn-small" onClick={() => void handleRemove(member)}>
                  Remover
                </button>
              </div>
            ))}
            {members.length === 0 && (
              <p className="muted">Ninguem mais tem acesso a esta nota.</p>
            )}
          </div>
        )}

        <form className="share-form" onSubmit={(event) => void handleAdd(event)}>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="email@de quem convidar"
            required
          />
          <select value={role} onChange={(event) => setRole(event.target.value as 'editor' | 'viewer')}>
            <option value="editor">Editor</option>
            <option value="viewer">Leitor</option>
          </select>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? '...' : 'Adicionar'}
          </button>
        </form>

        <p className="muted" style={{ marginTop: 10 }}>
          A pessoa precisa ter uma conta no SynapseNotes.
        </p>

        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}

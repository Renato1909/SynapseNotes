// Avatares dos usuários conectados na nota, lidos da Awareness do provedor.

import { useEffect, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';

interface PresenceUser {
  clientId: number;
  name: string;
  color: string;
}

interface PresenceBarProps {
  awareness: Awareness;
}

export function PresenceBar({ awareness }: PresenceBarProps) {
  const [users, setUsers] = useState<PresenceUser[]>([]);

  useEffect(() => {
    const collect = () => {
      const list: PresenceUser[] = [];
      for (const [clientId, state] of awareness.getStates()) {
        const user = state.user as { name?: string; color?: string } | undefined;
        if (!user?.name) continue;
        list.push({ clientId, name: user.name, color: user.color || '#6ea8fe' });
      }
      list.sort((a, b) => a.clientId - b.clientId);
      setUsers(list);
    };

    collect();
    awareness.on('change', collect);
    return () => awareness.off('change', collect);
  }, [awareness]);

  if (users.length === 0) return null;

  const visible = users.slice(0, 5);
  const overflow = users.length - visible.length;

  return (
    <div className="presence" title={users.map((u) => u.name).join(', ')}>
      {visible.map((u) => (
        <span key={u.clientId} className="avatar" style={{ background: u.color }} title={u.name}>
          {initials(u.name)}
        </span>
      ))}
      {overflow > 0 && (
        <span className="avatar" style={{ background: 'var(--bg-hover)', color: 'var(--text-dim)' }}>
          +{overflow}
        </span>
      )}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '?';
  const second = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (first + second).toUpperCase();
}

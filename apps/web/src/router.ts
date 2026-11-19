import { useCallback, useEffect, useState } from 'react';

// Router minimo baseado em History API: sem dependencia externa,
// URLs compartilhaveis (/notes/:id) e suporte a voltar/avançar.
export interface Route {
  path: string;
}

export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): string {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return path;
}

export function useNavigate(): (path: string) => void {
  return useCallback((path: string) => navigate(path), []);
}

// Converte /notes/abc em { name: 'editor', noteId: 'abc' } etc.
export type AppRoute =
  | { name: 'login' }
  | { name: 'register' }
  | { name: 'notes' }
  | { name: 'editor'; noteId: string }
  | { name: 'not-found' };

export function parseRoute(path: string): AppRoute {
  if (path === '/' || path === '/notes') return { name: 'notes' };
  if (path === '/login') return { name: 'login' };
  if (path === '/register') return { name: 'register' };
  const noteMatch = /^\/notes\/([0-9a-f-]{36})$/.exec(path);
  if (noteMatch && noteMatch[1]) return { name: 'editor', noteId: noteMatch[1] };
  return { name: 'not-found' };
}

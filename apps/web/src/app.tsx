import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type SessionUser } from './api.ts';
import { parseRoute, useRoute, type AppRoute } from './router.ts';
import { AuthPage } from './pages/AuthPage.tsx';
import { NotesListPage } from './pages/NotesListPage.tsx';
import { EditorPage } from './pages/EditorPage.tsx';

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  setUser: (user: SessionUser | null) => void;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  setUser: () => undefined
});

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const path = useRoute();
  const route: AppRoute = parseRoute(path);

  // Restaura sessao a partir do cookie HttpOnly.
  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((result) => {
        if (!cancelled) setUser(result.user);
      })
      .catch(() => {
        // 401 = sem sessao; segue para o login.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div className="loading-page">Carregando...</div>;

  const authRoute = route.name === 'login' || route.name === 'register';
  if (!user && !authRoute) {
    return (
      <AuthContext.Provider value={{ user, loading, setUser }}>
        <AuthPage mode="login" />
      </AuthContext.Provider>
    );
  }

  if (user && authRoute) {
    // Ja logado: manda para a lista de notas.
    window.history.replaceState({}, '', '/notes');
    return (
      <AuthContext.Provider value={{ user, loading, setUser }}>
        <NotesListPage />
      </AuthContext.Provider>
    );
  }

  return (
    <AuthContext.Provider value={{ user, loading, setUser }}>
      {route.name === 'login' && <AuthPage mode="login" />}
      {route.name === 'register' && <AuthPage mode="register" />}
      {route.name === 'notes' && <NotesListPage />}
      {route.name === 'editor' && <EditorPage noteId={route.noteId} />}
      {route.name === 'not-found' && (
        <div className="center-page">
          <div className="card" style={{ textAlign: 'center' }}>
            <h1>404</h1>
            <p className="muted">Pagina nao encontrada.</p>
            <button className="btn" onClick={() => window.history.replaceState({}, '', '/notes')}>
              Voltar para notas
            </button>
          </div>
        </div>
      )}
    </AuthContext.Provider>
  );
}

import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.ts';
import { useAuth } from '../app.tsx';
import { navigate } from '../router.ts';

interface AuthPageProps {
  mode: 'login' | 'register';
}

export function AuthPage({ mode }: AuthPageProps) {
  const { setUser } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = isRegister
        ? await api.register({ name, email, password })
        : await api.login({ email, password });
      setUser(result.user);
      navigate('/notes');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha na conexao. Tente novamente.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-page">
      <form className="card auth-card" onSubmit={handleSubmit}>
        <h1>
          Synapse<span style={{ color: 'var(--accent)' }}>Notes</span>
        </h1>
        <p className="hint">
          {isRegister ? 'Crie sua conta e comece a escrever em tempo real.' : 'Entre para acessar suas notas.'}
        </p>

        {error && <div className="error-box">{error}</div>}

        {isRegister && (
          <label className="field">
            <span>Nome</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Seu nome"
              required
              minLength={2}
              maxLength={80}
              autoComplete="name"
            />
          </label>
        )}

        <label className="field">
          <span>E-mail</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="voce@exemplo.com"
            required
            autoComplete="email"
          />
        </label>

        <label className="field">
          <span>Senha</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={isRegister ? 'Minimo 8 caracteres, com letras e numeros' : 'Sua senha'}
            required
            minLength={8}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
          />
        </label>

        <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Aguarde...' : isRegister ? 'Criar conta' : 'Entrar'}
        </button>

        <p className="muted" style={{ marginTop: 16, textAlign: 'center' }}>
          {isRegister ? (
            <>
              Ja tem conta?{' '}
              <a
                href="/login"
                onClick={(event) => {
                  event.preventDefault();
                  navigate('/login');
                }}
              >
                Entrar
              </a>
            </>
          ) : (
            <>
              Nao tem conta?{' '}
              <a
                href="/register"
                onClick={(event) => {
                  event.preventDefault();
                  navigate('/register');
                }}
              >
                Criar conta
              </a>
            </>
          )}
        </p>
      </form>
    </div>
  );
}

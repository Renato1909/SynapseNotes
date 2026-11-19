// Handlers de autenticacao: registro, login, logout e sessao atual.

import { cleanText, isValidEmail, isValidName, isValidPassword, normalizeEmail } from '@synapsenotes/shared';
import { HttpError, json, readJson } from './http.ts';
import { authenticatedUser, createSession, destroySession, hashPassword, isRateLimited, verifyPassword } from './security.ts';

interface AuthEnv {
  DB: D1Database;
  AUTH_RATE_LIMITER?: RateLimit;
}

function publicUser(row: { id: number; name: string; email: string; created_at?: string }) {
  return { id: Number(row.id), name: row.name, email: row.email };
}

async function authRateLimit(env: AuthEnv, request: Request, bucket: string): Promise<void> {
  // Binding nativo de rate limit quando disponivel; fallback em D1 fora do runtime.
  if (env.AUTH_RATE_LIMITER) {
    const { success } = await env.AUTH_RATE_LIMITER.limit({ key: bucket });
    if (!success) throw new HttpError(429, 'rate_limited', 'Muitas tentativas. Aguarde um minuto.');
    return;
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  if (await isRateLimited(env, `auth:${bucket}:${ip}`, 10, 60)) {
    throw new HttpError(429, 'rate_limited', 'Muitas tentativas. Aguarde um minuto.');
  }
}

export async function handleRegister(request: Request, env: AuthEnv): Promise<Response> {
  await authRateLimit(env, request, 'register');
  const body = await readJson<{ name?: unknown; email?: unknown; password?: unknown }>(request);

  const name = cleanText(body.name, 80);
  if (!isValidName(name)) throw new HttpError(400, 'invalid_name', 'Nome invalido.');
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) throw new HttpError(400, 'invalid_email', 'E-mail invalido.');
  const passwordCheck = isValidPassword(body.password);
  if (!passwordCheck.ok) throw new HttpError(400, 'invalid_password', passwordCheck.error || 'Senha invalida.');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) throw new HttpError(409, 'email_taken', 'Ja existe uma conta com este e-mail.');

  const inserted = await env.DB.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .bind(name, email, await hashPassword(String(body.password)))
    .run();

  const userId = Number(inserted.meta.last_row_id);
  const cookie = await createSession(userId, request, env);
  return json(201, { user: { id: userId, name, email } }, { 'Set-Cookie': cookie });
}

export async function handleLogin(request: Request, env: AuthEnv): Promise<Response> {
  await authRateLimit(env, request, 'login');
  const body = await readJson<{ email?: unknown; password?: unknown }>(request);
  const email = normalizeEmail(body.email);

  const row = await env.DB.prepare('SELECT id, name, email, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number; name: string; email: string; password_hash: string }>();

  const valid = row ? await verifyPassword(String(body.password ?? ''), row.password_hash) : false;
  if (!row || !valid) throw new HttpError(401, 'invalid_credentials', 'E-mail ou senha incorretos.');

  const cookie = await createSession(Number(row.id), request, env);
  return json(200, { user: publicUser(row) }, { 'Set-Cookie': cookie });
}

export async function handleLogout(request: Request, env: AuthEnv): Promise<Response> {
  const cookie = await destroySession(request, env);
  return json(200, { ok: true }, cookie ? { 'Set-Cookie': cookie } : {});
}

export async function handleMe(request: Request, env: AuthEnv): Promise<Response> {
  const user = await authenticatedUser(request, env);
  if (!user) throw new HttpError(401, 'unauthenticated', 'Sessao invalida ou expirada.');
  return json(200, { user: publicUser(user) });
}

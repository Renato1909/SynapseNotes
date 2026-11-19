// Seguranca: hash de senha (PBKDF2 via Web Crypto), cookies de sessao e
// rate limit por bucket. Padrao adotado da LensClick, portado para TypeScript.

export const SESSION_COOKIE = 'synapsenotes_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100_000;

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function randomToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}${'$'}${bytesToBase64Url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [algorithm, iterationsValue, saltValue, hashValue] = stored.split('$');
    const iterations = Number(iterationsValue);
    if (algorithm !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || iterations < 1 || !saltValue || !hashValue) {
      return false;
    }
    const expected = base64UrlToBytes(hashValue);
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: base64UrlToBytes(saltValue), iterations },
      key,
      expected.length * 8
    );
    const actual = new Uint8Array(bits);
    let difference = 0;
    for (let index = 0; index < actual.length; index += 1) {
      difference |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
    }
    return difference === 0;
  } catch {
    return false;
  }
}

export function parseCookies(request: Request): Record<string, string> {
  return Object.fromEntries(
    String(request.headers.get('Cookie') || '')
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const index = entry.indexOf('=');
        return index < 0 ? [entry, ''] : [entry.slice(0, index), decodeURIComponent(entry.slice(index + 1))];
      })
  );
}

export function sessionCookie(token: string, request: Request, maxAge = Math.floor(SESSION_TTL_MS / 1000)): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookie(request: Request): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export interface SessionUserRow {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  created_at: string;
  authenticated_session_hash: string;
}

export async function authenticatedUser(request: Request, env: { DB: D1Database }): Promise<SessionUserRow | null> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  return env.DB.prepare(`
    SELECT u.id, u.name, u.email, u.password_hash, u.created_at,
           s.token_hash AS authenticated_session_hash
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(await sha256(token), Date.now()).first<SessionUserRow>();
}

export async function createSession(
  userId: number,
  request: Request,
  env: { DB: D1Database }
): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(
      await sha256(token),
      userId,
      now + SESSION_TTL_MS
    )
  ]);
  return sessionCookie(token, request);
}

export async function destroySession(request: Request, env: { DB: D1Database }): Promise<string | null> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return clearSessionCookie(request);
}

// Rate limit simples persistido em D1 (chave, contador, expiracao).
export async function isRateLimited(
  env: { DB: D1Database },
  bucket: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT request_count, expires_at FROM rate_limits WHERE bucket_key = ?')
    .bind(bucket)
    .first<{ request_count: number; expires_at: number }>();
  if (!row || Number(row.expires_at) <= now) {
    await env.DB.prepare(
      'INSERT INTO rate_limits (bucket_key, request_count, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket_key) DO UPDATE SET request_count = 1, expires_at = excluded.expires_at'
    )
      .bind(bucket, now + windowSeconds * 1000)
      .run();
    return false;
  }
  const count = Number(row.request_count) + 1;
  await env.DB.prepare('UPDATE rate_limits SET request_count = ? WHERE bucket_key = ?').bind(count, bucket).run();
  return count > limit;
}

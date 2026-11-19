// Fluxo completo de autenticacao contra o Worker real, com D1 em memoria.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.ts';
import { MockD1, TEST_ORIGIN } from '../test-support/mock-d1.ts';

test('Worker executa o fluxo completo de autenticacao', async (t) => {
  const DB = new MockD1();
  const env = { DB } as unknown as Parameters<typeof worker.fetch>[1];
  let cookie = '';
  t.after(() => DB.close());

  async function request(
    path: string,
    { method = 'GET', body, withCookie = true, sendOrigin = true }: {
      method?: string;
      body?: unknown;
      withCookie?: boolean;
      sendOrigin?: boolean;
    } = {}
  ) {
    const response = await worker.fetch(
      new Request(TEST_ORIGIN + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(sendOrigin && method !== 'GET' && method !== 'HEAD' ? { Origin: TEST_ORIGIN } : {}),
          ...(withCookie && cookie ? { Cookie: cookie } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      }),
      env,
      {} as ExecutionContext
    );
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0] || '';
    const contentType = response.headers.get('content-type') || '';
    const json = contentType.includes('json') ? ((await response.json()) as any) : null;
    return { response, json };
  }

  // Registro
  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Renato Teste', email: 'RENATO@example.com', password: 'Segura123' }
  });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.json.user.email, 'renato@example.com');
  assert.match(cookie, /^synapsenotes_session=/);
  assert.match(registration.response.headers.get('set-cookie') || '', /HttpOnly; SameSite=Lax/);
  assert.match(registration.response.headers.get('set-cookie') || '', /Secure/);

  // Senha armazenada com hash, nunca em texto puro
  const storedUser = DB.prepare('SELECT * FROM users WHERE email = ?').bind('renato@example.com').first() as any;
  assert.match(storedUser.password_hash, /^pbkdf2-sha256\$100000\$/);
  assert.doesNotMatch(storedUser.password_hash, /Segura123/);

  // Sessao atual
  const me = await request('/api/auth/me');
  assert.equal(me.response.status, 200);
  assert.equal(me.json.user.name, 'Renato Teste');
  assert.equal('password_hash' in me.json.user, false);

  // Registro duplicado
  const duplicate = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Outra Pessoa', email: 'renato@example.com', password: 'Segura123' }
  });
  assert.equal(duplicate.response.status, 409);

  // Login correto
  cookie = '';
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'renato@example.com', password: 'Segura123' }
  });
  assert.equal(login.response.status, 200);
  assert.match(cookie, /^synapsenotes_session=/);

  // Login incorreto
  const badLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'renato@example.com', password: 'SenhaErrada1' }
  });
  assert.equal(badLogin.response.status, 401);

  // Sem Origin em rota mutante e bloqueado
  const noOrigin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'renato@example.com', password: 'Segura123' },
    withCookie: false,
    sendOrigin: false
  });
  assert.equal(noOrigin.response.status, 403);

  // Logout revoga a sessao
  const logout = await request('/api/auth/logout', { method: 'POST' });
  assert.equal(logout.response.status, 200);
  const afterLogout = await request('/api/auth/me');
  assert.equal(afterLogout.response.status, 401);
});

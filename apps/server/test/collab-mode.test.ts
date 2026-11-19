// Colaboracao: upgrade encaminhado para /connect, persistencia do modo no D1
// e notificacao da sala (remocao de membro). Cobre correcoes de bugs que os
// testes de handlers nao alcançavam.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.ts';
import { MockD1, TEST_ORIGIN } from '../test-support/mock-d1.ts';

interface DocCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function createEnv() {
  const DB = new MockD1();
  const calls: DocCall[] = [];
  const NOTES = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push({
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers.entries()),
          body: request.method === 'GET' ? null : await request.text()
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    })
  };
  const env = { DB, NOTES } as unknown as Parameters<typeof worker.fetch>[1];
  return { DB, env, calls, close: () => DB.close() };
}

function makeRequest(env: Parameters<typeof worker.fetch>[1], cookies: Record<string, string>) {
  return async function request(
    path: string,
    user: string,
    { method = 'GET', body, sendUpgrade = false }: { method?: string; body?: unknown; sendUpgrade?: boolean } = {}
  ) {
    const response = await worker.fetch(
      new Request(TEST_ORIGIN + path, {
        method,
        headers: {
          ...(method !== 'GET' ? { Origin: TEST_ORIGIN } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(sendUpgrade ? { Upgrade: 'websocket' } : {}),
          ...(cookies[user] ? { Cookie: cookies[user] } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      }),
      env,
      {} as ExecutionContext
    );
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookies[user] = setCookie.split(';')[0] || '';
    const contentType = response.headers.get('content-type') || '';
    const json = contentType.includes('json') ? ((await response.json()) as any) : null;
    return { response, json };
  };
}

test('Troca de modo persiste no D1 e o upgrade vai para /connect', async (t) => {
  const { env, DB, calls, close } = createEnv();
  const cookies: Record<string, string> = {};
  const request = makeRequest(env, cookies);
  t.after(close);

  const registration = await request('/api/auth/register', 'dono', {
    method: 'POST',
    body: { name: 'Dono', email: 'dono@exemplo.com', password: 'Segura123' }
  });
  assert.equal(registration.response.status, 201);

  const created = await request('/api/notes', 'dono', {
    method: 'POST',
    body: { title: 'Nota', mode: 'rich' }
  });
  assert.equal(created.response.status, 201);
  const noteId = created.json.note.id as string;

  // Upgrade sem sessao nao toca na sala
  const anonymous = await request(`/collab/${noteId}`, 'sem-cookie', { sendUpgrade: true });
  assert.equal(anonymous.response.status, 401);
  assert.equal(calls.length, 0);

  // Upgrade autenticado: a sala recebe /connect com a identidade nos headers
  const upgrade = await request(`/collab/${noteId}`, 'dono', { sendUpgrade: true });
  assert.equal(upgrade.response.status, 200, 'a resposta vem do DO (mock)');
  assert.equal(calls.length, 1);
  const connectCall = calls[0];
  assert.ok(connectCall);
  assert.equal(new URL(connectCall.url).pathname, '/connect');
  assert.equal(connectCall.headers['x-note-id'], noteId);
  assert.match(connectCall.headers['x-user-id'] || '', /^\d+$/);
  assert.equal(connectCall.headers['upgrade'], 'websocket');

  // PUT /mode grava no D1 (bug: so notificava o DO) e notifica a sala
  const switchMode = await request(`/api/notes/${noteId}/mode`, 'dono', {
    method: 'PUT',
    body: { mode: 'markdown' }
  });
  assert.equal(switchMode.response.status, 200);
  const row = DB.prepare('SELECT mode FROM notes WHERE id = ?').bind(noteId).first() as { mode: string };
  assert.equal(row.mode, 'markdown');
  assert.equal(calls.length, 2);
  const modeCall = calls[1];
  assert.ok(modeCall);
  assert.equal(new URL(modeCall.url).pathname, '/mode');
  assert.deepEqual(JSON.parse(modeCall.body || 'null'), { mode: 'markdown', role: 'owner' });

  // Reconexao anuncia o modo ja persistido
  const reconnect = await request(`/collab/${noteId}`, 'dono', { sendUpgrade: true });
  assert.equal(reconnect.response.status, 200);
  const connect = calls[2];
  assert.ok(connect);
  assert.equal(new URL(connect.url).pathname, '/connect');
  assert.equal(connect.headers['x-note-mode'], 'markdown');
});

test('Viewer nao troca o modo e remocao de membro derruba a sala', async (t) => {
  const { env, calls, close } = createEnv();
  const cookies: Record<string, string> = {};
  const request = makeRequest(env, cookies);
  t.after(close);

  for (const [user, email] of [
    ['dono', 'dono@exemplo.com'],
    ['leitor', 'leitor@exemplo.com']
  ] as const) {
    const registration = await request('/api/auth/register', user, {
      method: 'POST',
      body: { name: user, email, password: 'Segura123' }
    });
    assert.equal(registration.response.status, 201);
  }

  const created = await request('/api/notes', 'dono', {
    method: 'POST',
    body: { title: 'Nota', mode: 'rich' }
  });
  const noteId = created.json.note.id as string;

  const shared = await request(`/api/notes/${noteId}/members`, 'dono', {
    method: 'POST',
    body: { email: 'leitor@exemplo.com', role: 'viewer' }
  });
  assert.equal(shared.response.status, 201);
  const memberId = shared.json.member.user.id as number;

  // Viewer tenta trocar o modo: bloqueado e a sala nao recebe nada
  const denied = await request(`/api/notes/${noteId}/mode`, 'leitor', {
    method: 'PUT',
    body: { mode: 'markdown' }
  });
  assert.equal(denied.response.status, 403);
  assert.equal(calls.length, 0);

  // Remover o membro corta conexoes via notificacao /members
  const removed = await request(`/api/notes/${noteId}/members/${memberId}`, 'dono', {
    method: 'DELETE'
  });
  assert.equal(removed.response.status, 200);
  assert.equal(calls.length, 1);
  const membersCall = calls[0];
  assert.ok(membersCall);
  assert.equal(new URL(membersCall.url).pathname, '/members');
  assert.equal(membersCall.method, 'DELETE');
  assert.deepEqual(JSON.parse(membersCall.body || 'null'), { userId: memberId });

  // Apos a remocao o acesso novo e negado
  const after = await request(`/api/notes/${noteId}`, 'leitor');
  assert.equal(after.response.status, 404);
});
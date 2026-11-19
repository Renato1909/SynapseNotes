// CRUD de notas, compartilhamento por e-mail e papeis (owner/editor/viewer).

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.ts';
import { MockD1, TEST_ORIGIN } from '../test-support/mock-d1.ts';

test('Worker executa CRUD de notas e compartilhamento com papeis', async (t) => {
  const DB = new MockD1();
  const env = { DB } as unknown as Parameters<typeof worker.fetch>[1];
  t.after(() => DB.close());

  const cookies: Record<string, string> = {};

  async function request(
    path: string,
    user: string,
    { method = 'GET', body }: { method?: string; body?: unknown } = {}
  ) {
    const response = await worker.fetch(
      new Request(TEST_ORIGIN + path, {
        method,
        headers: {
          ...(method !== 'GET' ? { Origin: TEST_ORIGIN } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
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
  }

  async function register(user: string, email: string) {
    const result = await request('/api/auth/register', user, {
      method: 'POST',
      body: { name: `Usuario ${user}`, email, password: 'Segura123' }
    });
    assert.equal(result.response.status, 201, `registro de ${user} falhou`);
  }

  await register('dono', 'dono@example.com');
  await register('amigo', 'amigo@example.com');
  await register('curioso', 'curioso@example.com');

  // Criar nota
  const created = await request('/api/notes', 'dono', {
    method: 'POST',
    body: { title: '  Lista   de  compras ', mode: 'rich' }
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.json.note.title, 'Lista de compras');
  assert.equal(created.json.note.role, 'owner');
  assert.equal(created.json.note.mode, 'rich');
  const noteId = created.json.note.id as string;
  assert.match(noteId, /^[0-9a-f-]{36}$/);

  // Listar notas: so o que o usuario participa
  const listDono = await request('/api/notes', 'dono');
  assert.equal(listDono.response.status, 200);
  assert.equal(listDono.json.notes.length, 1);
  const listCurioso = await request('/api/notes', 'curioso');
  assert.equal(listCurioso.json.notes.length, 0);

  // Detalhe: nao participante recebe 404 (nao vaza existencia)
  const detailCurioso = await request(`/api/notes/${noteId}`, 'curioso');
  assert.equal(detailCurioso.response.status, 404);

  // Atualizar titulo e modo
  const updated = await request(`/api/notes/${noteId}`, 'dono', {
    method: 'PUT',
    body: { title: 'Lista atualizada', mode: 'markdown' }
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.json.note.title, 'Lista atualizada');
  assert.equal(updated.json.note.mode, 'markdown');

  // Nao participante nao atualiza
  const updateCurioso = await request(`/api/notes/${noteId}`, 'curioso', {
    method: 'PUT',
    body: { title: 'hackeada' }
  });
  assert.equal(updateCurioso.response.status, 404);

  // Compartilhar: dono adiciona amigo como editor
  const addMember = await request(`/api/notes/${noteId}/members`, 'dono', {
    method: 'POST',
    body: { email: 'AMIGO@example.com', role: 'editor' }
  });
  assert.equal(addMember.response.status, 201);
  assert.equal(addMember.json.member.role, 'editor');

  // E-mail inexistente
  const addGhost = await request(`/api/notes/${noteId}/members`, 'dono', {
    method: 'POST',
    body: { email: 'naoexiste@example.com', role: 'viewer' }
  });
  assert.equal(addGhost.response.status, 404);

  // Apenas owner compartilha
  const addByMember = await request(`/api/notes/${noteId}/members`, 'amigo', {
    method: 'POST',
    body: { email: 'curioso@example.com', role: 'viewer' }
  });
  assert.equal(addByMember.response.status, 403);

  // Editor edita
  const editorUpdate = await request(`/api/notes/${noteId}`, 'amigo', {
    method: 'PUT',
    body: { title: 'Editada pelo amigo' }
  });
  assert.equal(editorUpdate.response.status, 200);

  // Lista de membros
  const members = await request(`/api/notes/${noteId}/members`, 'dono');
  assert.equal(members.response.status, 200);
  assert.equal(members.json.members.length, 1);
  assert.equal(members.json.members[0].user.email, 'amigo@example.com');

  // Downgrade para viewer: editor passa a ser bloqueado
  const memberId = members.json.members[0].user.id as number;
  const downgrade = await request(`/api/notes/${noteId}/members/${memberId}`, 'dono', {
    method: 'PUT',
    body: { role: 'viewer' }
  });
  assert.equal(downgrade.response.status, 200);

  const viewerUpdate = await request(`/api/notes/${noteId}`, 'amigo', {
    method: 'PUT',
    body: { title: 'viewer nao pode' }
  });
  assert.equal(viewerUpdate.response.status, 403);

  // Dono unico pode excluir
  const deleteByViewer = await request(`/api/notes/${noteId}`, 'amigo', { method: 'DELETE' });
  assert.equal(deleteByViewer.response.status, 403);

  const removeMember = await request(`/api/notes/${noteId}/members/${memberId}`, 'dono', {
    method: 'DELETE'
  });
  assert.equal(removeMember.response.status, 200);
  const afterRemove = await request(`/api/notes/${noteId}`, 'amigo');
  assert.equal(afterRemove.response.status, 404);

  const deleted = await request(`/api/notes/${noteId}`, 'dono', { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  const afterDelete = await request(`/api/notes/${noteId}`, 'dono');
  assert.equal(afterDelete.response.status, 404);
});

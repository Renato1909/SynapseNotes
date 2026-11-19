// Teste de contrato: a tabela de rotas e os handlers do worker precisam
// permanecer em sincronia (mesmo padrao da LensClick).

import test from 'node:test';
import assert from 'node:assert/strict';
import { listApiRoutes, matchApiRoute } from '../src/router.ts';

test('toda rota tem id unico e caminho ou pattern', () => {
  const routes = listApiRoutes();
  assert.ok(routes.length >= 14, 'esperava ao menos 14 rotas');
  const ids = new Set<string>();
  for (const route of routes) {
    assert.ok(!ids.has(route.id), `id duplicado: ${route.id}`);
    ids.add(route.id);
    assert.ok(route.path || route.pattern, `rota ${route.id} sem caminho`);
    assert.ok(['GET', 'POST', 'PUT', 'DELETE'].includes(route.method), `metodo invalido em ${route.id}`);
  }
});

test('matchApiRoute resolve rotas fixas', () => {
  assert.deepEqual(matchApiRoute('/api/health', 'GET'), { id: 'health', params: [] });
  assert.deepEqual(matchApiRoute('/api/auth/register', 'POST'), { id: 'auth.register', params: [] });
  assert.deepEqual(matchApiRoute('/api/notes', 'GET'), { id: 'notes.list', params: [] });
  assert.equal(matchApiRoute('/api/notes', 'DELETE'), null);
  assert.equal(matchApiRoute('/api/rota-inexistente', 'GET'), null);
});

test('matchApiRoute resolve rotas com parametros na ordem correta', () => {
  const noteId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  assert.deepEqual(matchApiRoute(`/api/notes/${noteId}`, 'GET'), { id: 'notes.detail', params: [noteId] });
  assert.deepEqual(matchApiRoute(`/api/notes/${noteId}`, 'PUT'), { id: 'notes.update', params: [noteId] });
  assert.deepEqual(matchApiRoute(`/api/notes/${noteId}`, 'DELETE'), { id: 'notes.delete', params: [noteId] });
  assert.deepEqual(matchApiRoute(`/api/notes/${noteId}/members`, 'POST'), {
    id: 'notes.members.add',
    params: [noteId]
  });
  assert.deepEqual(matchApiRoute(`/api/notes/${noteId}/members/42`, 'PUT'), {
    id: 'notes.members.update',
    params: [noteId, '42']
  });
  assert.deepEqual(matchApiRoute(`/api/notes/${noteId}/members/42`, 'DELETE'), {
    id: 'notes.members.remove',
    params: [noteId, '42']
  });
});

test('rota especifica (/members) vence a generica (/notes/:id)', () => {
  const noteId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const match = matchApiRoute(`/api/notes/${noteId}/members`, 'GET');
  assert.equal(match?.id, 'notes.members.list');
});

test('ids invalidos de nota nao casam com o pattern', () => {
  assert.equal(matchApiRoute('/api/notes/abc', 'GET'), null);
  assert.equal(matchApiRoute('/api/notes/1234', 'PUT'), null);
});

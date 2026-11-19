// Worker principal: roteia a API REST e faz o upgrade do WebSocket de
// colaboracao para o Durable Object NoteRoom (um por nota).

import { HttpError, json, methodAllowsAnonymous, requestOriginIsAllowed, readJson } from './http.ts';
import { matchApiRoute, listApiRoutes, routeRequiresOriginCheck, type RouteId } from './router.ts';
import { authenticatedUser } from './security.ts';
import {
  handleAddMember,
  handleCreateNote,
  handleDeleteNote,
  handleGetNote,
  handleListMembers,
  handleListNotes,
  handleRemoveMember,
  handleUpdateMember,
  handleUpdateNote
} from './notes.ts';
import { handleLogin, handleLogout, handleMe, handleRegister } from './auth.ts';
import { NoteRoom } from './room.ts';

export { NoteRoom };

interface Env {
  DB: D1Database;
  NOTES: DurableObjectNamespace;
  AUTH_RATE_LIMITER?: RateLimit;
  WRITE_RATE_LIMITER?: RateLimit;
  ALLOWED_ORIGINS?: string;
}

const CORS_MAX_AGE = 600;

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowed = new Set(
    [new URL(request.url).origin, ...(env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean)]
  );
  if (!origin || !allowed.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': String(CORS_MAX_AGE),
    'Vary': 'Origin'
  };
}

function allowedOriginList(request: Request, env: Env): string[] {
  return (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .concat(new URL(request.url).origin);
}

async function handleCollabUpgrade(request: Request, env: Env, noteId: string): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return json(426, { error: 'WebSocket esperado.' });
  }

  const user = await authenticatedUser(request, env);
  if (!user) return json(401, { error: 'Sessao invalida ou expirada.' });

  // Papel resolvido no banco antes de tocar no DO.
  const row = await env.DB.prepare(`
    SELECT CASE WHEN n.owner_id = ? THEN 'owner' ELSE m.role END AS role, n.mode
    FROM notes n
    LEFT JOIN note_members m ON m.note_id = n.id AND m.user_id = ?
    WHERE n.id = ? AND (n.owner_id = ? OR m.user_id IS NOT NULL)
  `)
    .bind(user.id, user.id, noteId, user.id)
    .first<{ role: 'owner' | 'editor' | 'viewer'; mode: 'rich' | 'markdown' }>();

  if (!row) return json(404, { error: 'Nota nao encontrada.' });
  if (row.role !== 'owner' && row.role !== 'editor' && row.role !== 'viewer') {
    return json(403, { error: 'Acesso negado.' });
  }

  const id = env.NOTES.idFromName(noteId);
  const stub = env.NOTES.get(id);

  // Repassa a identidade via headers confiaveis ( Worker -> DO ).
  // A URL interna precisa ser /connect: o DO roteia pelo pathname.
  const internalRequest = new Request('http://do/connect', {
    method: 'GET',
    headers: {
      'X-User-Id': String(user.id),
      'X-User-Role': row.role,
      'X-Note-Id': noteId,
      'X-Note-Mode': row.mode,
      'Upgrade': 'websocket'
    }
  });

  return stub.fetch(internalRequest);
}

async function dispatch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  // Rota de colaboracao (prefixo proprio, fora da tabela REST).
  const collabMatch = /^\/collab\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (collabMatch && collabMatch[1]) {
    return handleCollabUpgrade(request, env, collabMatch[1]);
  }

  // Rota de modo: notifica o DO apos alteracao no D1.
  const modeMatch = /^\/api\/notes\/([0-9a-f-]{36})\/mode$/.exec(url.pathname);
  if (modeMatch && modeMatch[1] && method === 'PUT') {
    return notifyModeChange(request, env, modeMatch[1]);
  }

  // CORS preflight antes da tabela: OPTIONS nao existe nela.
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  const match = matchApiRoute(url.pathname, method);
  if (!match) {
    if (url.pathname.startsWith('/api/')) return json(404, { error: 'Rota nao encontrada.' });
    return json(404, { error: 'Nao encontrado.' });
  }

  const cors = corsHeaders(request, env);

  // Protecao de origem em rotas mutantes (como na LensClick).
  if (routeRequiresOriginCheck(match.id, method)) {
    if (!requestOriginIsAllowed(request, allowedOriginList(request, env))) {
      return json(403, { error: 'Origem nao permitida.' }, cors);
    }
  } else if (!methodAllowsAnonymous(method) && !requestOriginIsAllowed(request, allowedOriginList(request, env))) {
    return json(403, { error: 'Origem nao permitida.' }, cors);
  }

  try {
    const response = await route(match.id, match.params, request, env);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) headers.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    if (error instanceof HttpError) {
      return json(error.status, { error: error.message, code: error.code }, cors);
    }
    console.error('erro_interno', error instanceof Error ? error.message : String(error));
    return json(500, { error: 'Erro interno.' }, cors);
  }
}

async function notifyModeChange(request: Request, env: Env, noteId: string): Promise<Response> {
  const user = await authenticatedUser(request, env);
  if (!user) return json(401, { error: 'Sessao invalida ou expirada.' });

  const body = await readJson<{ mode?: unknown }>(request);
  if (body.mode !== 'rich' && body.mode !== 'markdown') return json(400, { error: 'Modo invalido.' });

  const role = await env.DB.prepare(`
    SELECT CASE WHEN n.owner_id = ? THEN 'owner' ELSE m.role END AS role
    FROM notes n
    LEFT JOIN note_members m ON m.note_id = n.id AND m.user_id = ?
    WHERE n.id = ? AND (n.owner_id = ? OR m.user_id IS NOT NULL)
  `)
    .bind(user.id, user.id, noteId, user.id)
    .first<{ role: string }>();
  if (!role) return json(404, { error: 'Nota nao encontrada.' });
  if (role.role === 'viewer') return json(403, { error: 'Voce tem acesso somente de leitura.' });

  // Persiste antes de notificar: reconexoes leem o modo do D1.
  await env.DB.prepare(
    'UPDATE notes SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  )
    .bind(body.mode, noteId)
    .run();

  const stub = env.NOTES.get(env.NOTES.idFromName(noteId));
  await stub.fetch(new Request(`http://do/mode`, { method: 'PUT', body: JSON.stringify({ mode: body.mode, role: role.role }) }));
  return json(200, { ok: true });
}

async function route(id: RouteId, params: string[], request: Request, env: Env): Promise<Response> {
  switch (id) {
    case 'health':
      return json(200, { ok: true, service: 'synapsenotes', now: new Date().toISOString() });
    case 'auth.register':
      return handleRegister(request, env);
    case 'auth.login':
      return handleLogin(request, env);
    case 'auth.logout':
      return handleLogout(request, env);
    case 'auth.me':
      return handleMe(request, env);
    case 'notes.list':
      return handleListNotes(request, env);
    case 'notes.create':
      return handleCreateNote(request, env);
    case 'notes.detail':
      return handleGetNote(request, env, params[0] || '');
    case 'notes.update':
      return handleUpdateNote(request, env, params[0] || '');
    case 'notes.delete':
      return handleDeleteNote(request, env, params[0] || '');
    case 'notes.members.list':
      return handleListMembers(request, env, params[0] || '');
    case 'notes.members.add':
      return handleAddMember(request, env, params[0] || '');
    case 'notes.members.update':
      return handleUpdateMember(request, env, params[0] || '', params[1] || '');
    case 'notes.members.remove':
      return handleRemoveMember(request, env, params[0] || '', params[1] || '');
    default:
      return json(404, { error: 'Rota nao encontrada.' });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return dispatch(request, env);
  }
};

// Expor a tabela de rotas ajuda nos testes de contrato.
export { listApiRoutes };

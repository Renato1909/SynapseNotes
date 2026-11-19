// Handlers de notas: CRUD, membros (compartilhamento) e papéis.
// A identidade é sempre via sessão; papel é resolvido por nota.

import { cleanText, isMemberRole, isNoteMode, isValidNoteTitle, type MemberRole, type NoteSummary } from '@synapsenotes/shared';
import { HttpError, json, readJson } from './http.ts';
import { authenticatedUser, isRateLimited, type SessionUserRow } from './security.ts';

interface NotesEnv {
  DB: D1Database;
  WRITE_RATE_LIMITER?: RateLimit;
  NOTES?: DurableObjectNamespace;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function requireUser(request: Request, env: NotesEnv): Promise<SessionUserRow> {
  const user = await authenticatedUser(request, env);
  if (!user) throw new HttpError(401, 'unauthenticated', 'Sessao invalida ou expirada.');
  return user;
}

async function writeRateLimit(env: NotesEnv, request: Request, bucket: string): Promise<void> {
  if (env.WRITE_RATE_LIMITER) {
    const { success } = await env.WRITE_RATE_LIMITER.limit({ key: bucket });
    if (!success) throw new HttpError(429, 'rate_limited', 'Muitas requisicoes. Aguarde.');
    return;
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  if (await isRateLimited(env, `write:${bucket}:${ip}`, 30, 60)) {
    throw new HttpError(429, 'rate_limited', 'Muitas requisicoes. Aguarde.');
  }
}

interface NoteRoleRow {
  note_id: string;
  title: string;
  mode: 'rich' | 'markdown';
  owner_id: number;
  owner_name: string;
  created_at: string;
  updated_at: string;
  role: MemberRole | null;
}

async function loadNoteRole(env: NotesEnv, noteId: string, userId: number): Promise<NoteRoleRow> {
  if (!UUID_PATTERN.test(noteId)) throw new HttpError(404, 'not_found', 'Nota nao encontrada.');
  const row = await env.DB.prepare(`
    SELECT n.id AS note_id, n.title, n.mode, n.owner_id, n.created_at, n.updated_at,
           u.name AS owner_name,
           CASE WHEN n.owner_id = ? THEN 'owner' ELSE m.role END AS role
    FROM notes n
    JOIN users u ON u.id = n.owner_id
    LEFT JOIN note_members m ON m.note_id = n.id AND m.user_id = ?
    WHERE n.id = ? AND (n.owner_id = ? OR m.user_id IS NOT NULL)
  `)
    .bind(userId, userId, noteId, userId)
    .first<NoteRoleRow>();
  if (!row) throw new HttpError(404, 'not_found', 'Nota nao encontrada.');
  return row;
}

function toSummary(row: NoteRoleRow): NoteSummary {
  return {
    id: row.note_id,
    title: row.title,
    mode: row.mode,
    role: (row.role || 'viewer') as MemberRole,
    ownerName: row.owner_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function handleListNotes(request: Request, env: NotesEnv): Promise<Response> {
  const user = await requireUser(request, env);
  const result = await env.DB.prepare(`
    SELECT n.id AS note_id, n.title, n.mode, n.owner_id, n.created_at, n.updated_at,
           u.name AS owner_name,
           CASE WHEN n.owner_id = ? THEN 'owner' ELSE m.role END AS role
    FROM notes n
    JOIN users u ON u.id = n.owner_id
    LEFT JOIN note_members m ON m.note_id = n.id AND m.user_id = ?
    WHERE n.owner_id = ? OR m.user_id IS NOT NULL
    ORDER BY n.updated_at DESC
    LIMIT 200
  `)
    .bind(user.id, user.id, user.id)
    .all<NoteRoleRow>();
  return json(200, { notes: (result.results || []).map(toSummary) });
}

export async function handleCreateNote(request: Request, env: NotesEnv): Promise<Response> {
  const user = await requireUser(request, env);
  await writeRateLimit(env, request, 'notes-create');
  const body = await readJson<{ title?: unknown; mode?: unknown }>(request);

  const title = cleanText(body.title, 120) || 'Sem titulo';
  if (!isValidNoteTitle(title)) throw new HttpError(400, 'invalid_title', 'Titulo invalido.');
  const mode = isNoteMode(body.mode) ? body.mode : 'rich';

  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO notes (id, title, mode, owner_id) VALUES (?, ?, ?, ?)')
    .bind(id, title, mode, user.id)
    .run();

  const row = await env.DB.prepare(`
    SELECT n.id AS note_id, n.title, n.mode, n.owner_id, n.created_at, n.updated_at,
           u.name AS owner_name, 'owner' AS role
    FROM notes n JOIN users u ON u.id = n.owner_id WHERE n.id = ?
  `)
    .bind(id)
    .first<NoteRoleRow>();
  if (!row) throw new HttpError(500, 'internal', 'Falha ao criar a nota.');
  return json(201, { note: toSummary(row) });
}

export async function handleGetNote(request: Request, env: NotesEnv, noteId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const row = await loadNoteRole(env, noteId, user.id);
  return json(200, { note: toSummary(row) });
}

export async function handleUpdateNote(request: Request, env: NotesEnv, noteId: string): Promise<Response> {
  const user = await requireUser(request, env);
  await writeRateLimit(env, request, 'notes-update');
  const row = await loadNoteRole(env, noteId, user.id);
  if (row.role === 'viewer') throw new HttpError(403, 'forbidden', 'Voce tem acesso somente de leitura.');

  const body = await readJson<{ title?: unknown; mode?: unknown }>(request);
  const sets: string[] = [];
  const values: (string | number)[] = [];

  if (body.title !== undefined) {
    const title = cleanText(body.title, 120);
    if (!isValidNoteTitle(title)) throw new HttpError(400, 'invalid_title', 'Titulo invalido.');
    sets.push('title = ?');
    values.push(title);
  }
  if (body.mode !== undefined) {
    if (!isNoteMode(body.mode)) throw new HttpError(400, 'invalid_mode', 'Modo invalido.');
    sets.push('mode = ?');
    values.push(body.mode);
  }
  if (!sets.length) throw new HttpError(400, 'empty_update', 'Nada para atualizar.');

  sets.push('updated_at = CURRENT_TIMESTAMP');
  values.push(noteId, user.id);
  await env.DB.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`)
    .bind(...values)
    .run();

  const updated = await loadNoteRole(env, noteId, user.id);
  return json(200, { note: toSummary(updated) });
}

export async function handleDeleteNote(request: Request, env: NotesEnv, noteId: string): Promise<Response> {
  const user = await requireUser(request, env);
  await writeRateLimit(env, request, 'notes-delete');
  const row = await loadNoteRole(env, noteId, user.id);
  if (row.role !== 'owner') throw new HttpError(403, 'forbidden', 'Apenas o dono pode excluir a nota.');
  await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(noteId).run();
  return json(200, { ok: true });
}

export async function handleListMembers(request: Request, env: NotesEnv, noteId: string): Promise<Response> {
  const user = await requireUser(request, env);
  await loadNoteRole(env, noteId, user.id);
  const result = await env.DB.prepare(`
    SELECT u.id, u.name, u.email, m.role, m.created_at
    FROM note_members m JOIN users u ON u.id = m.user_id
    WHERE m.note_id = ? ORDER BY m.created_at ASC
  `)
    .bind(noteId)
    .all<{ id: number; name: string; email: string; role: 'editor' | 'viewer'; created_at: string }>();
  const members = (result.results || []).map((row) => ({
    user: { id: Number(row.id), name: row.name, email: row.email },
    role: row.role,
    addedAt: row.created_at
  }));
  return json(200, { members });
}

export async function handleAddMember(request: Request, env: NotesEnv, noteId: string): Promise<Response> {
  const user = await requireUser(request, env);
  await writeRateLimit(env, request, 'members-add');
  const row = await loadNoteRole(env, noteId, user.id);
  if (row.role !== 'owner') throw new HttpError(403, 'forbidden', 'Apenas o dono pode compartilhar.');

  const body = await readJson<{ email?: unknown; role?: unknown }>(request);
  const email = String(body.email || '').trim().toLowerCase();
  const role = body.role;
  if (!isMemberRole(role)) throw new HttpError(400, 'invalid_role', 'Papel invalido (editor ou viewer).');

  const target = await env.DB.prepare('SELECT id, name, email FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number; name: string; email: string }>();
  if (!target) throw new HttpError(404, 'user_not_found', 'Nenhum usuario com este e-mail.');
  if (Number(target.id) === row.owner_id) throw new HttpError(400, 'already_owner', 'Este usuario ja e o dono.');

  const existing = await env.DB.prepare('SELECT role FROM note_members WHERE note_id = ? AND user_id = ?')
    .bind(noteId, Number(target.id))
    .first();
  if (existing) throw new HttpError(409, 'already_member', 'Este usuario ja e membro.');

  await env.DB.prepare('INSERT INTO note_members (note_id, user_id, role) VALUES (?, ?, ?)')
    .bind(noteId, Number(target.id), role)
    .run();

  return json(201, {
    member: { user: { id: Number(target.id), name: target.name, email: target.email }, role, addedAt: new Date().toISOString() }
  });
}

export async function handleUpdateMember(
  request: Request,
  env: NotesEnv,
  noteId: string,
  memberId: string
): Promise<Response> {
  const user = await requireUser(request, env);
  await writeRateLimit(env, request, 'members-update');
  const row = await loadNoteRole(env, noteId, user.id);
  if (row.role !== 'owner') throw new HttpError(403, 'forbidden', 'Apenas o dono pode alterar papeis.');

  const body = await readJson<{ role?: unknown }>(request);
  if (!isMemberRole(body.role)) throw new HttpError(400, 'invalid_role', 'Papel invalido (editor ou viewer).');
  const targetId = Number(memberId);
  if (targetId === row.owner_id) throw new HttpError(400, 'is_owner', 'O papel do dono nao muda.');

  const result = await env.DB.prepare('UPDATE note_members SET role = ? WHERE note_id = ? AND user_id = ?')
    .bind(body.role, noteId, targetId)
    .run();
  if (result.meta.changes === 0) throw new HttpError(404, 'not_found', 'Membro nao encontrado.');
  return json(200, { ok: true, role: body.role });
}

export async function handleRemoveMember(
  request: Request,
  env: NotesEnv,
  noteId: string,
  memberId: string
): Promise<Response> {
  const user = await requireUser(request, env);
  await writeRateLimit(env, request, 'members-remove');
  const row = await loadNoteRole(env, noteId, user.id);
  if (row.role !== 'owner') throw new HttpError(403, 'forbidden', 'Apenas o dono pode remover membros.');
  const targetId = Number(memberId);
  if (targetId === row.owner_id) throw new HttpError(400, 'is_owner', 'O dono nao pode ser removido.');

  const result = await env.DB.prepare('DELETE FROM note_members WHERE note_id = ? AND user_id = ?')
    .bind(noteId, targetId)
    .run();
  if (result.meta.changes === 0) throw new HttpError(404, 'not_found', 'Membro nao encontrado.');

  // Corta conexoes WebSocket ja abertas do usuario removido (melhor esforco:
  // a remocao no D1 ja protege reconexoes; uma falha aqui nao pode desfaze-la).
  if (env.NOTES) {
    try {
      const stub = env.NOTES.get(env.NOTES.idFromName(noteId));
      await stub.fetch(
        new Request('http://do/members', {
          method: 'DELETE',
          body: JSON.stringify({ userId: targetId })
        })
      );
    } catch (error) {
      console.error('falha_ao_notificar_sala', error instanceof Error ? error.message : String(error));
    }
  }
  return json(200, { ok: true });
}

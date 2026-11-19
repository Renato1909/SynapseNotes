// NoteRoom: Durable Object que hospeda o documento Yjs de uma nota.
// Um DO por nota. Responsabilidades:
//   1. Autenticar a conexao WebSocket (cookie de sessao validado no Worker).
//   2. Manter o Y.Doc em memoria, aplicando updates vindos dos clientes.
//   3. Persistir o estado do doc no storage proprio (SQLite-backed) de forma
//      debounced, e recarregar no boot.
//   4. Repassar awareness (presenca) entre os clientes.
//
// O protocolo de frames binarios e definido em @synapsenotes/shared/protocol.

import { decodeFrame, encodeFrame, encodeControl, MESSAGE_AWARENESS, MESSAGE_SYNC, type ControlEvent } from '@synapsenotes/shared';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { readSyncMessage, writeSyncStep1, writeSyncStep2 } from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

interface RoomEnv {
  DB: D1Database;
}

interface RoomMeta {
  noteId: string;
  userId: number;
  role: 'owner' | 'editor' | 'viewer';
  mode: 'rich' | 'markdown';
}

const PERSIST_DEBOUNCE_MS = 1000;
const MAX_MESSAGE_BYTES = 512 * 1024;
const MAX_CLIENTS_PER_ROOM = 30;

interface ClientState {
  userId: number;
  role: RoomMeta['role'];
  awarenessClientIds: Set<number>;
}

export class NoteRoom implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: RoomEnv;
  private doc: Y.Doc | null = null;
  private awareness: Awareness | null = null;
  private readonly clients = new Map<WebSocket, ClientState>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(state: DurableObjectState, env: RoomEnv) {
    this.state = state;
    this.env = env;
    // Mantem o DO vivo enquanto ha conexoes ativas.
    state.blockConcurrencyWhile(async () => {
      await this.loadDoc();
    });
  }

  private async loadDoc(): Promise<void> {
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);

    const stored = await this.state.storage.get<string>('ydoc');
    if (stored) {
      try {
        Y.applyUpdate(this.doc, base64ToBytes(stored), 'storage');
      } catch {
        // Corrompido: recomeca vazio em vez de derrubar a sala.
      }
    }

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.broadcastUpdate(update, origin);
      this.schedulePersist();
    });

    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = added.concat(updated, removed);
        const awareness = this.awareness;
        if (!awareness) return;
        // Rastreia quais clientIds pertencem a cada conexao (para limpeza no close).
        if (origin && typeof origin === 'object' && this.clients.has(origin as WebSocket)) {
          const client = this.clients.get(origin as WebSocket);
          if (client) for (const id of changed) client.awarenessClientIds.add(id);
        }
        const update = encodeAwarenessUpdate(awareness, changed);
        this.broadcastFrame(encodeFrame(MESSAGE_AWARENESS, update), origin);
      }
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (this.destroyed) return new Response('Sala encerrada.', { status: 500 });

    const url = new URL(request.url);
    if (url.pathname === '/connect') {
      return this.handleUpgrade(request);
    }
    if (url.pathname === '/mode' && request.method === 'PUT') {
      // Worker avisa troca de modo (apenas owner/editor).
      const body = (await request.json()) as { mode?: 'rich' | 'markdown'; role?: RoomMeta['role'] };
      if (body.mode !== 'rich' && body.mode !== 'markdown') {
        return Response.json({ error: 'Modo invalido.' }, { status: 400 });
      }
      this.broadcastControl({ event: 'mode-changed', mode: body.mode });
      return Response.json({ ok: true });
    }
    if (url.pathname === '/members' && request.method === 'DELETE') {
      // Notificacao de remocao de membro: derruba conexoes daquele usuario.
      const body = (await request.json()) as { userId?: number };
      if (typeof body.userId === 'number') this.disconnectUser(body.userId);
      return Response.json({ ok: true });
    }
    return new Response('Nao encontrado.', { status: 404 });
  }

  private async handleUpgrade(request: Request): Promise<Response> {
    const meta = readMeta(request);
    if (!meta) return new Response('Sem sala.', { status: 400 });

    const noteId = request.headers.get('X-Note-Id') || '';
    if (noteId) this.pendingNoteId = noteId;

    if (this.clients.size >= MAX_CLIENTS_PER_ROOM) {
      return new Response('Sala cheia.', { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.state.acceptWebSocket(server);
    this.clients.set(server, {
      userId: meta.userId,
      role: meta.role,
      awarenessClientIds: new Set()
    });

    // Handshake: sync inicial + estado atual de awareness + papel.
    const encoder = encoding.createEncoder();
    writeSyncStep1(encoder, this.doc!);
    server.send(encodeFrame(MESSAGE_SYNC, encoding.toUint8Array(encoder)));

    const step2 = encoding.createEncoder();
    writeSyncStep2(step2, this.doc!, Y.encodeStateVector(this.doc!));
    server.send(encodeFrame(MESSAGE_SYNC, encoding.toUint8Array(step2)));

    const states = this.awareness?.getStates();
    if (states && states.size > 0) {
      const awarenessUpdate = encodeAwarenessUpdate(this.awareness!, Array.from(states.keys()));
      server.send(encodeFrame(MESSAGE_AWARENESS, awarenessUpdate));
    }

    this.sendControl(server, { event: 'hello', role: meta.role, mode: await this.getMode() });

    return new Response(null, { status: 101, webSocket: client });
  }

  private async getMode(): Promise<'rich' | 'markdown'> {
    if (!this.pendingNoteId) return 'rich';
    try {
      const row = await this.env.DB.prepare('SELECT mode FROM notes WHERE id = ?')
        .bind(this.pendingNoteId)
        .first<{ mode: 'rich' | 'markdown' }>();
      return row?.mode === 'markdown' ? 'markdown' : 'rich';
    } catch {
      return 'rich';
    }
  }

  private pendingNoteId = '';

  // WebSocket hibernation API
  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === 'string') return;
    if (message.byteLength > MAX_MESSAGE_BYTES) {
      this.sendControl(socket, { event: 'error', code: 'rate_limited', message: 'Mensagem grande demais.' });
      return;
    }
    const frame = decodeFrame(message);
    if (!frame) return;
    const client = this.clients.get(socket);
    if (!client) return;

    if (frame.type === MESSAGE_SYNC) {
      // Viewers nao podem gravar: ignoramos updates deles silenciosamente.
      if (client.role === 'viewer') return;
      const decoder = decoding.createDecoder(frame.payload);
      const encoder = encoding.createEncoder();
      try {
        // Retorna 0 (step1 -> respondemos com step2), 1 (step2) ou 2 (update).
        // Updates aplicados disparam doc.on('update'), que faz o broadcast.
        readSyncMessage(decoder, encoder, this.doc!, socket);
        if (encoding.length(encoder) > 0) {
          socket.send(encodeFrame(MESSAGE_SYNC, encoding.toUint8Array(encoder)));
        }
      } catch {
        return;
      }
      return;
    }

    if (frame.type === MESSAGE_AWARENESS) {
      try {
        // O tracking de clientIds acontece no listener 'update' do awareness,
        // que recebe este socket como origin.
        applyAwarenessUpdate(this.awareness!, frame.payload, socket);
      } catch {
        return;
      }
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    this.removeClient(socket);
    try {
      socket.close(code, reason);
    } catch {
      // Ja fechado.
    }
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    this.removeClient(socket);
  }

  private removeClient(socket: WebSocket): void {
    const client = this.clients.get(socket);
    if (!client) return;
    this.clients.delete(socket);
    if (client.awarenessClientIds.size > 0) {
      removeAwarenessStates(this.awareness!, Array.from(client.awarenessClientIds), 'disconnect');
    }
    if (this.clients.size === 0) void this.persistNow();
  }

  private disconnectUser(userId: number): void {
    for (const [socket, client] of this.clients) {
      if (client.userId !== userId) continue;
      this.removeClient(socket);
      try {
        socket.close(4003, 'acesso_removido');
      } catch {
        // Ja fechado.
      }
    }
  }

  private broadcastUpdate(update: Uint8Array, origin: unknown): void {
    const frame = encodeFrame(MESSAGE_SYNC, encodeUpdateMessage(update));
    this.broadcastFrame(frame, origin);
  }

  private broadcastFrame(frame: Uint8Array, origin: unknown): void {
    for (const [socket] of this.clients) {
      if (socket === origin) continue; // Remetente ja aplicou localmente.
      try {
        socket.send(frame);
      } catch {
        this.removeClient(socket);
      }
    }
  }

  private broadcastControl(event: ControlEvent): void {
    const frame = encodeControl(event);
    for (const [socket] of this.clients) {
      try {
        socket.send(frame);
      } catch {
        this.removeClient(socket);
      }
    }
  }

  private sendControl(socket: WebSocket, event: ControlEvent): void {
    try {
      socket.send(encodeControl(event));
    } catch {
      this.removeClient(socket);
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persistNow(): Promise<void> {
    if (!this.doc || this.destroyed) return;
    try {
      await this.state.storage.put('ydoc', bytesToBase64(Y.encodeStateAsUpdate(this.doc)));
      await this.state.storage.put('updated_at', Date.now());
    } catch {
      // Storage indisponivel momentaneamente: tentaremos no proximo update.
    }
  }
}

// --- helpers de mensagem de sync (tipo interno do y-protocols) ---

const SYNC_STEP_UPDATE = 2;

function encodeUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, SYNC_STEP_UPDATE);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

function readMeta(request: Request): Omit<RoomMeta, 'noteId'> | null {
  const userId = Number(request.headers.get('X-User-Id'));
  const role = request.headers.get('X-User-Role');
  const mode = request.headers.get('X-Note-Mode');
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (role !== 'owner' && role !== 'editor' && role !== 'viewer') return null;
  return { userId, role, mode: mode === 'markdown' ? 'markdown' : 'rich' };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

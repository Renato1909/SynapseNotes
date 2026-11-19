// Provedor de colaboracao: conecta o Y.Doc local ao NoteRoom via WebSocket.
// Fala o protocolo binario definido em @synapsenotes/shared/protocol.
// Reconecta com backoff e reaplica o estado local apos cair.

import {
  decodeFrame,
  encodeFrame,
  MESSAGE_AWARENESS,
  MESSAGE_SYNC,
  MESSAGE_CONTROL,
  parseControl,
  type ControlEvent
} from '@synapsenotes/shared';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { readSyncMessage, writeSyncStep1, writeSyncStep2 } from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

export type ProviderStatus = 'connecting' | 'connected' | 'disconnected';

interface ProviderEvents {
  status: (status: ProviderStatus) => void;
  control: (event: ControlEvent) => void;
  sync: () => void;
}

export class CollabProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  private ws: WebSocket | null = null;
  private status: ProviderStatus = 'disconnected';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private readonly listeners: { [K in keyof ProviderEvents]: ProviderEvents[K][] } = {
    status: [],
    control: [],
    sync: []
  };

  constructor(
    private readonly noteId: string,
    doc?: Y.Doc
  ) {
    this.doc = doc ?? new Y.Doc();
    this.awareness = new Awareness(this.doc);

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      // Nao ecoa para o proprio servidor (la ja aplicou).
      if (origin === 'remote') return;
      this.send(encodeFrame(MESSAGE_SYNC, encodeUpdate(update)));
    });

    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === 'remote') return;
        const changed = added.concat(updated, removed);
        if (changed.length === 0) return;
        this.send(encodeFrame(MESSAGE_AWARENESS, encodeAwarenessUpdate(this.awareness, changed)));
      }
    );
  }

  on<K extends keyof ProviderEvents>(event: K, callback: ProviderEvents[K]): () => void {
    this.listeners[event].push(callback);
    return () => {
      const list = this.listeners[event] as ProviderEvents[K][];
      const index = list.indexOf(callback);
      if (index >= 0) list.splice(index, 1);
    };
  }

  private emit<K extends keyof ProviderEvents>(event: K, ...args: Parameters<ProviderEvents[K]>): void {
    for (const callback of [...this.listeners[event]]) {
      (callback as (...a: unknown[]) => void)(...args);
    }
  }

  setStatus(status: ProviderStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.closedByUser = false;
    this.setStatus('connecting');

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/collab/${this.noteId}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus('connected');

      // Handshake: pede o estado do servidor e anuncia o proprio.
      const step1 = encoding.createEncoder();
      writeSyncStep1(step1, this.doc);
      ws.send(encodeFrame(MESSAGE_SYNC, encoding.toUint8Array(step1)));

      const step2 = encoding.createEncoder();
      writeSyncStep2(step2, this.doc, Y.encodeStateVector(this.doc));
      ws.send(encodeFrame(MESSAGE_SYNC, encoding.toUint8Array(step2)));

      const states = this.awareness.getStates();
      if (states.size > 0) {
        ws.send(
          encodeFrame(MESSAGE_AWARENESS, encodeAwarenessUpdate(this.awareness, Array.from(states.keys())))
        );
      }
      this.emit('sync');
    };

    ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const frame = decodeFrame(event.data);
      if (!frame) return;

      if (frame.type === MESSAGE_SYNC) {
        const decoder = decoding.createDecoder(frame.payload);
        const encoder = encoding.createEncoder();
        try {
          readSyncMessage(decoder, encoder, this.doc, 'remote');
          if (encoding.length(encoder) > 0) {
            ws.send(encodeFrame(MESSAGE_SYNC, encoding.toUint8Array(encoder)));
          }
        } catch {
          // Quadro corrompido: ignora.
        }
        return;
      }

      if (frame.type === MESSAGE_AWARENESS) {
        try {
          applyAwarenessUpdate(this.awareness, frame.payload, 'remote');
        } catch {
          // Payload invalido: ignora.
        }
        return;
      }

      if (frame.type === MESSAGE_CONTROL) {
        const event2 = parseControl(frame.payload);
        if (event2) this.emit('control', event2);
      }
    };

    ws.onclose = () => {
      this.ws = null;
      // Limpa presencas remotas: ninguem esta mais na sala.
      const ids = Array.from(this.awareness.getStates().keys()).filter(
        (id) => id !== this.doc.clientID
      );
      if (ids.length > 0) removeAwarenessStates(this.awareness, ids, 'disconnect');

      if (this.closedByUser) {
        this.setStatus('disconnected');
        return;
      }
      this.setStatus('disconnected');
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose dispara em seguida; tratamento la.
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 15000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.connect();
    }, delay);
  }

  private send(frame: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(frame);
  }

  setLocalUser(user: { id: number; name: string; color: string }): void {
    this.awareness.setLocalStateField('user', user);
  }

  destroy(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        // Ja fechado.
      }
    }
    this.awareness.destroy();
    this.doc.destroy();
    this.setStatus('disconnected');
  }
}

// Mensagem de update no formato do y-protocols (tipo 2 = update).
function encodeUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 2);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

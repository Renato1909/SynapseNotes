// Protocolo binario do WebSocket de colaboracao.
// Quadro: [1 byte tipo][carga util]
//   0x01 sync      -> payload = mensagem de sincronismo Yjs (y-protocols/sync)
//   0x02 awareness -> payload = atualizacao de presença (y-protocols/awareness)
//   0x03 control   -> payload = JSON { event, ... } (erros, papel, modo da nota)
//
// O servidor (Durable Object) e o cliente usam este modulo para montar e
// interpretar quadros, garantindo que os dois lados falem a mesma linguagem.

export const MESSAGE_SYNC = 0x01;
export const MESSAGE_AWARENESS = 0x02;
export const MESSAGE_CONTROL = 0x03;

export type ControlEvent =
  | { event: 'hello'; role: 'owner' | 'editor' | 'viewer'; mode: 'rich' | 'markdown' }
  | { event: 'error'; code: 'forbidden' | 'not_found' | 'rate_limited'; message: string }
  | { event: 'mode-changed'; mode: 'rich' | 'markdown' };

export function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.byteLength + 1);
  frame[0] = type;
  frame.set(payload, 1);
  return frame;
}

export function encodeControl(event: ControlEvent): Uint8Array {
  return encodeFrame(MESSAGE_CONTROL, new TextEncoder().encode(JSON.stringify(event)));
}

export type DecodedFrame =
  | { type: typeof MESSAGE_SYNC; payload: Uint8Array }
  | { type: typeof MESSAGE_AWARENESS; payload: Uint8Array }
  | { type: typeof MESSAGE_CONTROL; payload: Uint8Array };

export function decodeFrame(data: ArrayBuffer | Uint8Array): DecodedFrame | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 1) return null;
  const type = bytes[0];
  if (type !== MESSAGE_SYNC && type !== MESSAGE_AWARENESS && type !== MESSAGE_CONTROL) return null;
  return { type: type as DecodedFrame['type'], payload: bytes.subarray(1) };
}

export function parseControl(payload: Uint8Array): ControlEvent | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(payload));
    if (value && typeof value === 'object' && 'event' in value) return value as ControlEvent;
    return null;
  } catch {
    return null;
  }
}

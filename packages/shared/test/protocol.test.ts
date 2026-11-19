import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeFrame,
  encodeControl,
  encodeFrame,
  MESSAGE_AWARENESS,
  MESSAGE_CONTROL,
  MESSAGE_SYNC,
  parseControl
} from '../src/protocol.ts';

test('encodeFrame adiciona o byte de tipo antes da carga util', () => {
  const payload = new Uint8Array([10, 20, 30]);
  const frame = encodeFrame(MESSAGE_SYNC, payload);
  assert.equal(frame.byteLength, 4);
  assert.equal(frame[0], MESSAGE_SYNC);
  assert.deepEqual(Array.from(frame.subarray(1)), [10, 20, 30]);
});

test('decodeFrame reconstroi o quadro e rejeita tipos desconhecidos', () => {
  const frame = encodeFrame(MESSAGE_AWARENESS, new Uint8Array([1, 2]));
  const decoded = decodeFrame(frame);
  assert.ok(decoded);
  assert.equal(decoded.type, MESSAGE_AWARENESS);
  assert.deepEqual(Array.from(decoded.payload), [1, 2]);

  assert.equal(decodeFrame(new Uint8Array([0x7f, 1])), null);
  assert.equal(decodeFrame(new Uint8Array([])), null);
});

test('decodeFrame aceita ArrayBuffer (formato do WebSocket)', () => {
  const frame = encodeFrame(MESSAGE_SYNC, new Uint8Array([9]));
  const decoded = decodeFrame(frame.buffer.slice(0) as ArrayBuffer);
  assert.ok(decoded);
  assert.equal(decoded.type, MESSAGE_SYNC);
});

test('encodeControl + parseControl fazem ida e volta de eventos', () => {
  const frame = encodeControl({ event: 'hello', role: 'editor', mode: 'markdown' });
  const decoded = decodeFrame(frame);
  assert.ok(decoded && decoded.type === MESSAGE_CONTROL);
  const event = parseControl(decoded.payload);
  assert.deepEqual(event, { event: 'hello', role: 'editor', mode: 'markdown' });
});

test('parseControl ignora JSON invalido ou sem campo event', () => {
  assert.equal(parseControl(new TextEncoder().encode('nao-json')), null);
  assert.equal(parseControl(new TextEncoder().encode('{"sem":"event"}')), null);
});

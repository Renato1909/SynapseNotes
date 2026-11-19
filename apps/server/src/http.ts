// Helpers HTTP: respostas JSON, leitura de corpo com limite e erros de
// dominio com status. Espelha o padrao da LensClick.

export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin'
});

const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(status: number, body: unknown, extraHeaders: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...extraHeaders }
  });
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  if (!String(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Envie os dados no formato JSON.');
  }
  const declaredSize = Number(request.headers.get('Content-Length') || 0);
  if (declaredSize > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Payload muito grande.');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, 'payload_too_large', 'Payload muito grande.');
  }
  try {
    return JSON.parse(text || '{}') as T;
  } catch {
    throw new HttpError(400, 'invalid_json', 'JSON invalido.');
  }
}

export function requestOriginIsAllowed(request: Request, allowedOrigins: string[] = []): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  return origin === new URL(request.url).origin || allowedOrigins.includes(origin);
}

export function methodAllowsAnonymous(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

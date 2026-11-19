// Tabela de rotas da API. Aspecificos antes dos genericos, para matching
// deterministico (mesmo padrao da LensClick). Os testes de contrato
// garantem que a tabela e os handlers continuem em sincronia.

export type RouteId =
  | 'health'
  | 'auth.register'
  | 'auth.login'
  | 'auth.logout'
  | 'auth.me'
  | 'notes.list'
  | 'notes.create'
  | 'notes.detail'
  | 'notes.update'
  | 'notes.delete'
  | 'notes.members.list'
  | 'notes.members.add'
  | 'notes.members.update'
  | 'notes.members.remove';

interface RouteDefinition {
  id: RouteId;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path?: string;
  pattern?: RegExp;
}

const API_ROUTES: readonly RouteDefinition[] = Object.freeze([
  { id: 'health', method: 'GET', path: '/api/health' },
  { id: 'auth.register', method: 'POST', path: '/api/auth/register' },
  { id: 'auth.login', method: 'POST', path: '/api/auth/login' },
  { id: 'auth.logout', method: 'POST', path: '/api/auth/logout' },
  { id: 'auth.me', method: 'GET', path: '/api/auth/me' },
  { id: 'notes.list', method: 'GET', path: '/api/notes' },
  { id: 'notes.create', method: 'POST', path: '/api/notes' },
  { id: 'notes.members.list', method: 'GET', pattern: /^\/api\/notes\/([0-9a-f-]{36})\/members$/ },
  { id: 'notes.members.add', method: 'POST', pattern: /^\/api\/notes\/([0-9a-f-]{36})\/members$/ },
  { id: 'notes.members.update', method: 'PUT', pattern: /^\/api\/notes\/([0-9a-f-]{36})\/members\/(\d+)$/ },
  { id: 'notes.members.remove', method: 'DELETE', pattern: /^\/api\/notes\/([0-9a-f-]{36})\/members\/(\d+)$/ },
  { id: 'notes.detail', method: 'GET', pattern: /^\/api\/notes\/([0-9a-f-]{36})$/ },
  { id: 'notes.update', method: 'PUT', pattern: /^\/api\/notes\/([0-9a-f-]{36})$/ },
  { id: 'notes.delete', method: 'DELETE', pattern: /^\/api\/notes\/([0-9a-f-]{36})$/ }
]);

export interface RouteMatch {
  id: RouteId;
  params: string[];
}

export function matchApiRoute(pathname: string, method: string): RouteMatch | null {
  const normalizedMethod = String(method || '').toUpperCase();
  for (const route of API_ROUTES) {
    if (route.method !== normalizedMethod) continue;
    if (route.path === pathname) return { id: route.id, params: [] };
    const match = route.pattern?.exec(pathname);
    if (match) return { id: route.id, params: match.slice(1) };
  }
  return null;
}

export function listApiRoutes(): readonly RouteDefinition[] {
  return API_ROUTES;
}

// Rotas mutantes exigem Origin valido (mesma origem ou allowlist do env).
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function routeRequiresOriginCheck(id: RouteId, method: string): boolean {
  if (!MUTATING_METHODS.has(String(method || '').toUpperCase())) return false;
  // logout pode ser chamado sem Origin quando nao ha sessao ativa? Nao:
  // mantemos uniforme: todas as mutacoes passam pelo check.
  return id !== 'health';
}

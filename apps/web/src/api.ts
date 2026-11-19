// Cliente HTTP da API. Cookies de sessao via credentials: 'include'.

import type { NoteMember, NoteSummary, PublicUser, SessionUser } from '@synapsenotes/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'include',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('json') ? await response.json() : null;

  if (!response.ok) {
    const error = payload as { error?: string; code?: string } | null;
    throw new ApiError(response.status, error?.code || 'error', error?.error || 'Erro inesperado.');
  }
  return payload as T;
}

export const api = {
  register: (data: { name: string; email: string; password: string }) =>
    request<{ user: SessionUser }>('/api/auth/register', { method: 'POST', body: data }),

  login: (data: { email: string; password: string }) =>
    request<{ user: SessionUser }>('/api/auth/login', { method: 'POST', body: data }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  me: () => request<{ user: SessionUser }>('/api/auth/me'),

  listNotes: () => request<{ notes: NoteSummary[] }>('/api/notes'),

  createNote: (data: { title?: string; mode?: 'rich' | 'markdown' }) =>
    request<{ note: NoteSummary }>('/api/notes', { method: 'POST', body: data }),

  getNote: (id: string) => request<{ note: NoteSummary }>(`/api/notes/${id}`),

  updateNote: (id: string, data: { title?: string; mode?: 'rich' | 'markdown' }) =>
    request<{ note: NoteSummary }>(`/api/notes/${id}`, { method: 'PUT', body: data }),

  deleteNote: (id: string) => request<{ ok: boolean }>(`/api/notes/${id}`, { method: 'DELETE' }),

  listMembers: (id: string) => request<{ members: NoteMember[] }>(`/api/notes/${id}/members`),

  addMember: (id: string, data: { email: string; role: 'editor' | 'viewer' }) =>
    request<{ member: NoteMember }>(`/api/notes/${id}/members`, { method: 'POST', body: data }),

  updateMember: (id: string, userId: number, role: 'editor' | 'viewer') =>
    request<{ ok: boolean }>(`/api/notes/${id}/members/${userId}`, { method: 'PUT', body: { role } }),

  removeMember: (id: string, userId: number) =>
    request<{ ok: boolean }>(`/api/notes/${id}/members/${userId}`, { method: 'DELETE' }),

  changeMode: (id: string, mode: 'rich' | 'markdown') =>
    request<{ ok: boolean }>(`/api/notes/${id}/mode`, { method: 'PUT', body: { mode } })
};

export type { NoteMember, NoteSummary, PublicUser, SessionUser };

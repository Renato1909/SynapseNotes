// Validacao pura de entradas da API. Sem I/O: testavel com node --test.

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

const OK: ValidationResult = { ok: true };

export function cleanText(value: unknown, max = 120): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export function isValidEmail(value: unknown): boolean {
  const email = normalizeEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

export function isValidPassword(value: unknown): ValidationResult {
  const password = String(value ?? '');
  if (password.length < 8) return { ok: false, error: 'A senha deve ter pelo menos 8 caracteres.' };
  if (password.length > 200) return { ok: false, error: 'A senha e longa demais.' };
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return { ok: false, error: 'A senha deve conter letras e numeros.' };
  }
  return OK;
}

export function isValidName(value: unknown): boolean {
  const name = cleanText(value, 80);
  return name.length >= 2 && name.length <= 80;
}

export function isValidNoteTitle(value: unknown): boolean {
  const title = cleanText(value, 120);
  return title.length >= 1 && title.length <= 120;
}

export function isNoteMode(value: unknown): value is 'rich' | 'markdown' {
  return value === 'rich' || value === 'markdown';
}

export function isMemberRole(value: unknown): value is 'editor' | 'viewer' {
  return value === 'editor' || value === 'viewer';
}

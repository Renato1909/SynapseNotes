import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText,
  isMemberRole,
  isNoteMode,
  isValidEmail,
  isValidName,
  isValidNoteTitle,
  isValidPassword,
  normalizeEmail
} from '../src/validation.ts';

test('cleanText normaliza espacos e limita tamanho', () => {
  assert.equal(cleanText('  nota   com   espacos  '), 'nota com espacos');
  assert.equal(cleanText('abc', 2), 'ab');
  assert.equal(cleanText(null), '');
});

test('normalizeEmail e isValidEmail', () => {
  assert.equal(normalizeEmail('  USER@Example.COM '), 'user@example.com');
  assert.ok(isValidEmail('renato@example.com'));
  assert.ok(!isValidEmail('sem-arroba'));
  assert.ok(!isValidEmail('a@b'));
  assert.ok(!isValidEmail(`${'a'.repeat(250)}@x.com`));
});

test('isValidPassword exige 8+ caracteres com letra e numero', () => {
  assert.ok(isValidPassword('Segura123').ok);
  assert.ok(!isValidPassword('curta1').ok);
  assert.ok(!isValidPassword('soletrasssen').ok);
  assert.ok(!isValidPassword('12345678').ok);
  assert.ok(!isValidPassword(null).ok);
});

test('isValidName e isValidNoteTitle', () => {
  assert.ok(isValidName('Renato'));
  assert.ok(!isValidName('R'));
  assert.ok(isValidNoteTitle('Minha nota'));
  assert.ok(!isValidNoteTitle('   '));
});

test('isNoteMode e isMemberRole so aceitam valores conhecidos', () => {
  assert.ok(isNoteMode('rich'));
  assert.ok(isNoteMode('markdown'));
  assert.ok(!isNoteMode('html'));
  assert.ok(isMemberRole('editor'));
  assert.ok(isMemberRole('viewer'));
  assert.ok(!isMemberRole('owner')); // owner nao e atribuivel
});

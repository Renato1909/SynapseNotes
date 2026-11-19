// Auto-teste do lint estatico: garante que as regras continuam detectando
// violacoes e que o codigo atual do repositorio esta limpo.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSource, runChecks } from '../scripts/lint.mjs';

test('o codigo atual passa no lint', () => {
  assert.deepEqual(runChecks(), []);
});

test('detecta import relativo sem extensao explicita', () => {
  const violations = checkSource([{ path: 'src/exemplo.ts', source: "import { algo } from './algo';" }]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /sem extensao explicita/);
});

test('aceita import relativo com extensao e import de pacote', () => {
  const source = [
    "import { algo } from './algo.ts';",
    "import './styles.css';",
    "import { x } from '@synapsenotes/shared';"
  ].join('\n');
  assert.deepEqual(checkSource([{ path: 'src/exemplo.ts', source }]), []);
});

test('detecta import relativo que cruza workspaces', () => {
  const source = "import { protocol } from '../../packages/shared/src/protocol.ts';";
  const violations = checkSource([{ path: 'src/exemplo.ts', source }]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /cruza workspaces/);
});

test('detecta console.log e storage no codigo de producao', () => {
  const source = "console.log('debug'); localStorage.setItem('x', '1');";
  const violations = checkSource([{ path: 'src/exemplo.ts', source }]);
  assert.equal(violations.length, 2);
  assert.match(violations[0], /console\.log/);
  assert.match(violations[1], /cookie HttpOnly/);
});

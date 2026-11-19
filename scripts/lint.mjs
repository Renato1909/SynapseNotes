// Lint estatico do monorepo, sem dependencias externas. Roda em
// `npm run lint`, no CI e e auto-coberto por test/lint.test.mjs.
//
// Regras:
//   1. Imports relativos precisam de extensao explicita (.ts/.tsx/.css),
//      exigida pelo Node ao rodar os testes em TypeScript nativo.
//   2. Nada de importar outro workspace por caminho relativo; use o nome
//      do pacote (@synapsenotes/*).
//   3. Sem console.log/debug no codigo de producao (deixe rastro util:
//      console.error/warn).
//   4. Sem localStorage/sessionStorage: a sessao vive no cookie HttpOnly.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const SOURCE_DIRS = [
  'packages/shared/src',
  'apps/server/src',
  'apps/server/test',
  'apps/web/src',
  'apps/web/test'
];

const FORBIDDEN_STORAGE = /\b(?:localStorage|sessionStorage)\b/;
const FORBIDDEN_CONSOLE = /\bconsole\.(?:log|debug)\s*\(/;
// Imports por caminho entre workspaces: '../../packages/shared/src/...'
const CROSS_WORKSPACE_PATH = /(?:^|['"])[^'"]*(?:^|\/)(?:packages|apps)\//;

function listFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...listFiles(full));
    else if (/\.(?:ts|tsx)$/.test(name)) files.push(full);
  }
  return files;
}

function checkRelativeExtensions(path, source, violations) {
  const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!/\.(?:ts|tsx|css)$/.test(specifier)) {
      violations.push(`${path}: import relativo '${specifier}' sem extensao explicita (.ts/.tsx/.css)`);
    }
  }
}

function checkCrossWorkspaceImports(path, source, violations) {
  const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    // Imports relativos nao podem entrar em outro workspace por caminho;
    // workspaces sao importados pelo nome (ex.: @synapsenotes/shared).
    if (specifier.startsWith('.') && (specifier.includes('packages/') || specifier.includes('apps/'))) {
      violations.push(
        `${path}: import '${specifier}' cruza workspaces; use o nome do pacote (@synapsenotes/*)`
      );
    }
  }
}

// Checa um conjunto de arquivos em memoria: { path, source }.
// Usada pelo runChecks e pelos testes (que alimentam sintetico).
export function checkSource(files) {
  const violations = [];
  for (const file of files) {
    const path = file.path;
    const source = file.source;
    checkRelativeExtensions(path, source, violations);
    checkCrossWorkspaceImports(path, source, violations);

    if (FORBIDDEN_CONSOLE.test(source)) {
      violations.push(`${path}: console.log/debug no codigo; use console.error ou console.warn`);
    }
    if (FORBIDDEN_STORAGE.test(source)) {
      violations.push(`${path}: localStorage/sessionStorage proibido; a sessao vive no cookie HttpOnly`);
    }
  }
  return violations;
}

// Varre os diretorios de fonte do repositorio.
export function runChecks() {
  const files = [];
  for (const dir of SOURCE_DIRS) {
    const full = join(ROOT, dir);
    for (const file of listFiles(full)) {
      files.push({ path: relative(ROOT, file).replaceAll('\\', '/'), source: readFileSync(file, 'utf8') });
    }
  }
  return checkSource(files);
}

// Execucao direta: `node scripts/lint.mjs`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = runChecks();
  if (violations.length > 0) {
    console.error(`Lint encontrou ${violations.length} problema(s):`);
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }
  console.log('Lint: nenhuma problema encontrado.');
}

// Sobe o Worker (wrangler, :8787) e o frontend (Vite, :5173) ao mesmo
// tempo, com a saída de cada um prefixada e encerramento limpo no Ctrl+C.

import { spawn } from 'node:child_process';

// `node scripts/dev.mjs --remote` roda o Worker no ambiente remoto da
// Cloudflare (nao requer o workerd local — util em maquinas afetadas
// pelo bug cloudflare/workerd#4668).
const remote = process.argv.includes('--remote');

const targets = [
  {
    tag: 'server',
    color: '\x1b[32m',
    args: ['run', remote ? 'dev:remote' : 'dev', '-w', '@synapsenotes/server']
  },
  { tag: 'web', color: '\x1b[36m', args: ['run', 'dev', '-w', '@synapsenotes/web'] }
];

const children = [];
let shuttingDown = false;

function pipeOutput(tag, color, stream) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length > 0) console.log(`${color}[${tag}]\x1b[0m ${line}`);
    }
  });
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Mata a arvore: npm -> cmd -> wrangler/vite.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  setTimeout(() => process.exit(code), 400);
}

for (const target of targets) {
  const child = spawn('npm', target.args, {
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  pipeOutput(target.tag, target.color, child.stdout);
  pipeOutput(target.tag, target.color, child.stderr);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`\x1b[31m[${target.tag}]\x1b[0m encerrou (código ${code}); parando os demais.`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`SynapseNotes em modo de desenvolvimento${remote ? ' (remoto)' : ''}:`);
console.log('  Worker  http://127.0.0.1:8787');
console.log('  Web     http://127.0.0.1:5173  (abra este)');
console.log(
  remote
    ? 'Primeira vez? Rode tambem: npm run db:migrate:remote'
    : 'Primeira vez? Rode tambem: npm run db:migrate:local'
);

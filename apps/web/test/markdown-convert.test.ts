// Testes da conversão rico <-> Markdown, usada na alternância de modo.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownToRichDoc, richToMarkdownText } from '../src/editor/markdown-convert.ts';
import { getTipTapSchema } from '../src/editor/extensions.ts';

test('o schema do TipTap e gerado uma unica vez', () => {
  assert.equal(getTipTapSchema(), getTipTapSchema());
  assert.ok(getTipTapSchema().nodes.paragraph);
  assert.ok(getTipTapSchema().nodes.bulletList);
  assert.ok(getTipTapSchema().nodes.image);
  assert.ok(getTipTapSchema().marks.bold);
  assert.ok(getTipTapSchema().marks.strike);
});

test('converte documento rico para markdown', () => {
  const schema = getTipTapSchema();
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Titulo da nota' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Texto com ' },
          { type: 'text', text: 'negrito', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' e ' },
          { type: 'text', text: 'italico', marks: [{ type: 'italic' }] },
          { type: 'text', text: '.' }
        ]
      },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'primeiro' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'segundo' }] }] }
        ]
      },
      { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'const a = 1;' }] },
      { type: 'horizontalRule' }
    ]
  });

  assert.equal(
    richToMarkdownText(doc),
    [
      '## Titulo da nota',
      '',
      'Texto com **negrito** e *italico*.',
      '',
      '- primeiro',
      '',
      '- segundo',
      '',
      '```js',
      'const a = 1;',
      '```',
      '',
      '---'
    ].join('\n')
  );
});

test('analisa markdown para os nomes camelCase do TipTap', () => {
  const doc = markdownToRichDoc('# Ola\n\nTexto com **forte**, ~~tachado~~ e `codigo`.\n\n- um\n- dois\n\n```py\nprint(1)\n```\n');
  const json = doc.toJSON() as { content?: Array<Record<string, any>> };
  const blocks = json.content ?? [];

  assert.equal(blocks[0]?.type, 'heading');
  assert.equal(blocks[0]?.attrs?.level, 1);

  const paragraph = blocks[1];
  assert.equal(paragraph?.type, 'paragraph');
  const marks: Array<string | undefined> = (paragraph?.content ?? []).map(
    (inline: { marks?: Array<{ type: string }> }) => inline.marks?.[0]?.type
  );
  assert.deepEqual(
    marks.filter((mark): mark is string => mark !== undefined),
    ['bold', 'strike', 'code']
  );

  // Listas usam os nomes camelCase, nao o snake_case do schema basico.
  assert.equal(blocks[2]?.type, 'bulletList');
  assert.equal(blocks[2]?.content?.[0]?.type, 'listItem');

  assert.equal(blocks[3]?.type, 'codeBlock');
  assert.equal(blocks[3]?.attrs?.language, 'py');
});

test('o codigo Markdown rico -> Markdown e estavel apos o primeiro passe', () => {
  const input = [
    '# Titulo',
    '',
    'Paragrafo com **negrito**, *italico*, ~~tachado~~, `codigo` e [link](https://exemplo.com).',
    '',
    '- um',
    '- dois',
    '',
    '1. primeiro',
    '2. segundo',
    '',
    '> citacao',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
    '---',
    ''
  ].join('\n');

  const first = richToMarkdownText(markdownToRichDoc(input));
  const second = richToMarkdownText(markdownToRichDoc(first));
  assert.equal(second, first);

  // O conteudo essencial sobrevive ao primeiro passe.
  assert.match(first, /^# Titulo/);
  assert.match(first, /\*\*negrito\*\*/);
  assert.match(first, /\*italico\*/);
  assert.match(first, /~~tachado~~/);
  assert.match(first, /`codigo`/);
  assert.match(first, /\[link\]\(https:\/\/exemplo\.com\)/);
  assert.match(first, /- um/);
  assert.match(first, /1\. primeiro/);
  assert.match(first, /> citacao/);
  assert.match(first, /```js\nconst a = 1;\n```/);
});

test('markdown vazio vira documento rico vazio', () => {
  const doc = markdownToRichDoc('');
  // O parser completa o doc com um paragrafo vazio: o schema exige block+.
  assert.ok(doc.childCount <= 1);
  assert.equal(richToMarkdownText(doc).trim(), '');
});

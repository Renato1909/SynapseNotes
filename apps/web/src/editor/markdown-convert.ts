// Conversão entre texto rico (TipTap/ProseMirror) e Markdown, usada na
// alternância de modo da nota.
//
// O prosemirror-markdown traz serializador e parser para o schema básico
// (nomes snake_case: bullet_list, strong, code_block...), mas o TipTap usa
// nomes camelCase (bulletList, bold, codeBlock...). Por isso os mapas de
// serialização e de tokens foram reescritos aqui para o schema do TipTap.

import {
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
  type MarkdownSerializerState,
  type ParseSpec
} from 'prosemirror-markdown';
import MarkdownIt from 'markdown-it';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { getTipTapSchema } from './extensions.ts';

// ---------- Rico -> Markdown ----------

// `inAutolink` é mantido em tempo de execução pelo prosemirror-markdown
// (controlado pelo spec de link reutilizado abaixo), mas não é publicado
// nos tipos do pacote.
function isInAutolink(state: MarkdownSerializerState): boolean {
  return (state as unknown as { inAutolink?: boolean }).inAutolink === true;
}

const richToMarkdown = new MarkdownSerializer(
  {
    paragraph(state, node) {
      state.renderInline(node);
      state.closeBlock(node);
    },
    heading(state, node) {
      state.write(`${'#'.repeat(node.attrs.level as number)} `);
      state.renderInline(node, false);
      state.closeBlock(node);
    },
    blockquote(state, node) {
      state.wrapBlock('> ', null, node, () => state.renderContent(node));
    },
    codeBlock(state, node) {
      // Cercas mais longas que qualquer sequência de crases dentro do bloco.
      const backticks = node.textContent.match(/`{3,}/gm);
      const fence = backticks ? backticks.sort().slice(-1)[0]! : '```';
      state.write(`${fence}${(node.attrs.language as string | null) ?? ''}\n`);
      state.text(node.textContent, false);
      state.write('\n');
      state.write(fence);
      state.closeBlock(node);
    },
    bulletList(state, node) {
      state.renderList(node, '  ', () => '- ');
    },
    orderedList(state, node) {
      const start = (node.attrs.order as number | null) ?? 1;
      const maxW = String(start + node.childCount - 1).length;
      const space = state.repeat(' ', maxW + 2);
      state.renderList(node, space, (index) => {
        const n = String(start + index);
        return `${state.repeat(' ', maxW - n.length)}${n}. `;
      });
    },
    listItem(state, node) {
      state.renderContent(node);
    },
    horizontalRule(state, node) {
      state.write('---');
      state.closeBlock(node);
    },
    hardBreak(state, node, parent, index) {
      // Quebra só é escrita se houver conteúdo depois dela.
      for (let i = index + 1; i < parent.childCount; i++) {
        if (parent.child(i).type !== node.type) {
          state.write('\\\n');
          return;
        }
      }
    },
    image(state, node) {
      const title = node.attrs.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : '';
      state.write(`![${state.esc((node.attrs.alt as string | null) ?? '')}](${node.attrs.src as string}${title})`);
    },
    text(state, node) {
      state.text(node.text ?? '', !isInAutolink(state));
    }
  },
  {
    bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
    italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
    strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    // Reutiliza a lógica padrão: contagem de crases em `code` e
    // autolink (<...>) em `link`, que também mantém `inAutolink`.
    code: defaultMarkdownSerializer.marks.code!,
    link: defaultMarkdownSerializer.marks.link!
  }
);

// ---------- Markdown -> Rico ----------

// Mesma implementação do prosemirror-markdown (não é exportada): uma lista
// é "tight" enquanto o próximo token não fechar o item atual oculto.
function listIsTight(tokens: readonly { type: string; hidden: boolean }[], index: number): boolean {
  let i = index;
  while (++i < tokens.length) {
    if (tokens[i]!.type !== 'list_item_open') return tokens[i]!.hidden;
  }
  return false;
}

const markdownTokens: Record<string, ParseSpec> = {
  blockquote: { block: 'blockquote' },
  paragraph: { block: 'paragraph' },
  list_item: { block: 'listItem' },
  bullet_list: {
    block: 'bulletList',
    getAttrs: (_token, tokens, index) => ({ tight: listIsTight(tokens, index) })
  },
  ordered_list: {
    block: 'orderedList',
    getAttrs: (token, tokens, index) => ({
      order: Number(token.attrGet('start')) || 1,
      tight: listIsTight(tokens, index)
    })
  },
  heading: { block: 'heading', getAttrs: (token) => ({ level: Number(token.tag.slice(1)) }) },
  code_block: { block: 'codeBlock', noCloseToken: true },
  fence: { block: 'codeBlock', getAttrs: (token) => ({ language: token.info || null }), noCloseToken: true },
  hr: { node: 'horizontalRule' },
  hardbreak: { node: 'hardBreak' },
  image: {
    node: 'image',
    getAttrs: (token) => ({
      src: token.attrGet('src'),
      title: token.attrGet('title') || null,
      alt: token.children?.[0]?.content ?? null
    })
  },
  em: { mark: 'italic' },
  strong: { mark: 'bold' },
  s: { mark: 'strike' },
  link: {
    mark: 'link',
    getAttrs: (token) => ({ href: token.attrGet('href'), title: token.attrGet('title') || null })
  },
  code_inline: { mark: 'code', noCloseToken: true }
};

// Criado sob demanda: montar o schema do TipTap é trabalho pesado e só é
// necessário quando alguém alterna de volta para o modo rico.
let markdownParser: MarkdownParser | null = null;

function getMarkdownParser(): MarkdownParser {
  markdownParser ??= new MarkdownParser(
    getTipTapSchema(),
    // CommonMark puro, com strikethrough (~~) habilitado para o mark strike.
    new MarkdownIt('commonmark', { html: false }).enable('strikethrough'),
    markdownTokens
  );
  return markdownParser;
}

// ---------- API pública ----------

// Serializa um documento rico para Markdown. A fonte de verdade do conteúdo
// rico é o Y.XmlFragment (não a view do editor), então quem chama lê o
// fragmento e passa o documento resultante.
export function richToMarkdownText(doc: ProseMirrorNode): string {
  return richToMarkdown.serialize(doc);
}

// Analisa Markdown e devolve um documento ProseMirror pronto para ser
// escrito no Y.XmlFragment.
export function markdownToRichDoc(markdown: string): ProseMirrorNode {
  return getMarkdownParser().parse(markdown);
}

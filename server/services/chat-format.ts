import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
/** Current chat adapters send plain text, not Markdown/HTML. Local history is unchanged. */
export function chatPlainText(source: string): string {
  const tree = parser.parse(source);
  const definitions = new Map<string, any>();
  const visit = (n: any) => {
    if (n.type === 'definition') definitions.set(n.identifier, n);
    for (const c of n.children || []) visit(c);
  };
  visit(tree);
  const link = (label: string, url: string) => {
    if (!url || label === url) return label || url;
    return label ? `${label} (${url})` : url;
  };
  const render = (n: any): string => {
    const inline = () => (n.children || []).map(render).join('');
    const blocks = () => (n.children || []).map(render).filter(Boolean).join('\n\n');
    switch (n.type) {
      case 'root':
      case 'blockquote':
      case 'listItem':
        return blocks();
      case 'text':
      case 'inlineCode':
      case 'code':
      case 'math':
      case 'inlineMath':
        return n.value || '';
      case 'paragraph':
      case 'heading':
      case 'emphasis':
      case 'strong':
        return inline();
      case 'delete':
        return `［删除：${inline()}］`;
      case 'break':
        return '\n';
      case 'thematicBreak':
        return '——';
      case 'link':
        return link(inline(), n.url);
      case 'image':
        return link(n.alt || '', n.url);
      case 'linkReference':
      case 'imageReference': {
        const label = n.type === 'imageReference' ? n.alt || '' : inline();
        return link(label, definitions.get(n.identifier)?.url || '');
      }
      case 'definition':
        return '';
      case 'footnoteReference':
        return `[${n.identifier}]`;
      case 'footnoteDefinition':
        return `[${n.identifier}] ${blocks()}`;
      case 'list':
        return n.children
          .map((item: any, i: number) => {
            const marker =
              item.checked != null
                ? item.checked
                  ? '☑'
                  : '☐'
                : n.ordered
                  ? `${(n.start || 1) + i}.`
                  : '•';
            return marker + ' ' + render(item).replace(/\n/g, '\n  ');
          })
          .join('\n');
      case 'table': {
        const rows = n.children.map((row: any) => row.children.map(render));
        const headers = rows.shift() || [];
        return rows.length
          ? rows
              .map(
                (row: string[], i: number) =>
                  `${i + 1}. ` +
                  row.map((value, col) => `${headers[col] || col + 1}：${value}`).join('；'),
              )
              .join('\n')
          : headers.join(' / ');
      }
      case 'tableCell':
        return inline();
      // HTML stays inert; keep text and intentional line breaks, remove only tags.
      case 'html':
        return n.value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '');
      default:
        return n.children ? inline() : n.value || '';
    }
  };
  return render(tree).trim();
}

import { PreviewContext, type PreviewInteraction } from '../preview-context';
import { richMarkdown, localMediaKind } from '../markdown-rich';
import { CodePreview } from './CodePreview';
import { mathDelimiters } from '../markdown-source';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark.css';
import { Check, Copy } from 'lucide-react';
import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
function plain(node: any): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(plain).join('');
  return node?.props ? plain(node.props.children) : '';
}
function Code({ children }: any) {
  const interaction = React.useContext(PreviewContext);
  const visual = /language-(html|html-preview|svg|mermaid|chart)(?:\s|$)/.test(
    children?.props?.className || '',
  );
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="code-block">
      {!visual && (
        <div className="code-bar">
          <span>{children?.props?.className?.match(/language-([^\s]+)/)?.[1] || 'code'}</span>
          <button
            aria-label="Copy code"
            onClick={async () => {
              await navigator.clipboard.writeText(plain(children));
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}{' '}
            {copied ? (interaction.zh ? '已复制' : 'Copied') : interaction.zh ? '复制' : 'Copy'}
          </button>
        </div>
      )}
      {/language-(html|html-preview|svg|mermaid|chart)(?:\s|$)/.test(
        children?.props?.className || '',
      ) ? (
        <CodePreview
          source={plain(children)}
          code={children}
          language={
            /language-chart(?:\s|$)/.test(children?.props?.className || '')
              ? 'chart'
              : /language-mermaid(?:\s|$)/.test(children?.props?.className || '')
                ? 'mermaid'
                : /language-svg(?:\s|$)/.test(children?.props?.className || '')
                  ? 'svg'
                  : 'html'
          }
        />
      ) : (
        <details className="code-source" open>
          <summary>代码 / Code</summary>
          <pre>{children}</pre>
        </details>
      )}
    </div>
  );
}
// react-markdown's synchronous export is a pure parser/renderer (no hooks).
// Cache its element tree, not mounted component state. Bound both count and source bytes.
const parsed = new Map<string, React.ReactElement>();
let cachedChars = 0;
const options = {
  remarkPlugins: [remarkGfm, remarkMath, richMarkdown],
  rehypePlugins: [
    [rehypeKatex, { trust: false, strict: 'ignore', maxSize: 20, maxExpand: 200 }],
    rehypeHighlight,
  ],
  components: {
    pre: Code,
    a: ({ node: _node, ...props }: any) => {
      const kind = localMediaKind(props.href || '');
      return kind ? (
        <span className="inline-media">
          {kind === 'video' ? (
            <video controls preload="metadata" src={props.href} />
          ) : (
            <audio controls preload="metadata" src={props.href} />
          )}
          <a {...props} />
        </span>
      ) : (
        <a {...props} target="_blank" rel="noopener noreferrer" />
      );
    },
    img: ({ node: _node, ...props }: any) => <img {...props} loading="lazy" decoding="async" />,
    blockquote: ({ node, children, ...props }: any) => (
      <blockquote {...props}>
        {(props['data-speaker'] || node?.properties?.dataSpeaker) && (
          <div className="speaker-label">
            {String(props['data-speaker'] || node?.properties?.dataSpeaker)}
          </div>
        )}
        {children}
      </blockquote>
    ),
  },
};
export const Markdown = React.memo(function Markdown({
  text,
  live = false,
  interaction,
}: {
  text: string;
  live?: boolean;
  interaction?: PreviewInteraction;
}) {
  let tree = live ? undefined : parsed.get(text);
  if (tree) {
    parsed.delete(text);
    parsed.set(text, tree);
  } else {
    tree = ReactMarkdown({ ...options, children: mathDelimiters(text) } as Parameters<
      typeof ReactMarkdown
    >[0]);
    if (!live && text.length <= 250000) {
      parsed.set(text, tree);
      cachedChars += text.length;
      while (parsed.size > 96 || cachedChars > 2000000) {
        const oldest = parsed.keys().next().value!;
        cachedChars -= oldest.length;
        parsed.delete(oldest);
      }
    }
  }
  return (
    <PreviewContext.Provider value={interaction || {}}>
      <div className="markdown">{tree}</div>
    </PreviewContext.Provider>
  );
});

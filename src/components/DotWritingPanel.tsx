import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { writingTools, type WritingMode } from '../../shared/dot-writing';

type Result = { source: string; option: string; start: number; end: number; value: string };
export function DotWritingPanel({
  mode,
  conversationId,
}: {
  mode: WritingMode;
  conversationId?: string;
}) {
  const tool = writingTools[mode];
  const editor = useRef<HTMLTextAreaElement>(null);
  const request = useRef<AbortController | null>(null);
  const [source, setSource] = useState('');
  const [options, setOptions] = useState<Partial<Record<WritingMode, string>>>({});
  const [results, setResults] = useState<Partial<Record<WritingMode, Result>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);
  const option = options[mode] ?? tool.choices[0] ?? '';
  const result = results[mode];
  useEffect(() => {
    setError('');
    setBusy(false);
    return () => request.current?.abort();
  }, [mode]);
  async function generate() {
    if (!conversationId || !source.trim()) return;
    const input = editor.current!;
    const start = input.selectionStart === input.selectionEnd ? 0 : input.selectionStart;
    const end = input.selectionStart === input.selectionEnd ? source.length : input.selectionEnd;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const { value } = await api(
        '/personal/dot/writing',
        { conversationId, mode, source: source.slice(start, end), option },
        'POST',
        {},
        controller.signal,
      );
      if (!controller.signal.aborted)
        setResults((old) => ({ ...old, [mode]: { source, option, start, end, value } }));
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '生成失败');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="dot-content dot-writing">
      <h2>{mode}</h2>
      <label>
        原文
        <textarea
          ref={editor}
          value={source}
          rows={6}
          maxLength={16000}
          onChange={(e) => setSource(e.target.value)}
          placeholder="粘贴原文，或选中其中一段处理"
        />
      </label>
      <label>
        {tool.field}
        {tool.choices.length ? (
          <select
            value={option}
            onChange={(e) => setOptions({ ...options, [mode]: e.target.value })}
          >
            {tool.choices.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        ) : (
          <textarea
            value={option}
            rows={3}
            maxLength={8000}
            onChange={(e) => setOptions({ ...options, [mode]: e.target.value })}
          />
        )}
      </label>
      <button
        disabled={busy || !conversationId || !source.trim() || !option.trim()}
        onClick={() => void generate()}
      >
        {busy ? '处理中…' : tool.action}
      </button>
      {!conversationId && <small>请先选择 Dot 会话。</small>}
      {error && <small role="alert">{error}</small>}
      {result && (
        <article>
          <h3>{tool.result}</h3>
          <p>{result.value}</p>
          {tool.edit && (
            <button
              disabled={source !== result.source || option !== result.option}
              onClick={() => {
                const next =
                  source.slice(0, result.start) + result.value + source.slice(result.end);
                setUndo({ before: source, after: next });
                setSource(next);
              }}
            >
              采纳到原文
            </button>
          )}
          <button onClick={() => setResults({ ...results, [mode]: undefined })}>忽略</button>
        </article>
      )}
      {undo && undo.after === source && (
        <button
          onClick={() => {
            setSource(undo.before);
            setUndo(null);
          }}
        >
          撤销上次采纳
        </button>
      )}
    </section>
  );
}

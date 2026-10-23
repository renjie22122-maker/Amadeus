import { diagramCopySource, diagramDirection } from './diagram-source';
let tail: Promise<unknown> = Promise.resolve();
export function renderDiagram(
  source: string,
  options: { dark?: boolean; direction?: string; spacing?: number; cancelled?: () => boolean } = {},
) {
  const work = tail
    .catch(() => {})
    .then(async () => {
      if (options.cancelled?.()) return null;
      if (source.length > 50000)
        throw new Error('Diagram exceeds the 50,000 character preview limit.');
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        maxTextSize: 50000,
        maxEdges: 500,
        suppressErrorRendering: true,
        theme: options.dark ? 'dark' : 'default',
        htmlLabels: false,
        secure: [
          'securityLevel',
          'startOnLoad',
          'maxTextSize',
          'maxEdges',
          'suppressErrorRendering',
          'htmlLabels',
        ],
        flowchart: {
          htmlLabels: false,
          nodeSpacing: options.spacing || 50,
          rankSpacing: options.spacing || 50,
        },
      });
      let text = source,
        repaired = false;
      try {
        await mermaid.parse(text);
      } catch (original) {
        const candidate = diagramCopySource(source);
        if (candidate === source) throw original;
        await mermaid.parse(candidate);
        text = candidate;
        repaired = true;
      }
      if (options.cancelled?.()) return null;
      const id = 'diagram-' + crypto.randomUUID();
      try {
        const { svg } = await mermaid.render(
          id,
          diagramDirection(text, options.direction || 'auto'),
        );
        return {
          url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
          svg,
          repaired,
        };
      } finally {
        document.getElementById('d' + id)?.remove();
      }
    });
  tail = work.catch(() => {});
  return work;
}

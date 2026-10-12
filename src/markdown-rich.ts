/** Conservative post-parse extensions: never rewrite code or explicitly escaped stars. */
export function richMarkdown() {
  return (tree: any, file: any) => {
    const source = String(file);
    function walk(node: any) {
      if (!node.children || ['code', 'inlineCode', 'html', 'strong'].includes(node.type)) return;
      if (node.type === 'blockquote') {
        const first = node.children[0]?.children?.[0];
        const match =
          first?.type === 'text' &&
          first.value.match(/^\[(?:speaker|角色):\s*([^\]\n]{1,60})\]\s*/i);
        if (match) {
          const name = match[1].trim();
          let hue = 0;
          for (const c of name) hue = (hue * 31 + c.codePointAt(0)!) >>> 0;
          node.data = {
            ...node.data,
            hProperties: {
              className: ['speaker-quote', 'speaker-color-' + (hue % 6)],
              'data-speaker': name,
            },
          };
          first.value = first.value.slice(match[0].length);
        }
      }
      node.children = node.children.flatMap((child: any) => {
        if (child.type !== 'text') {
          walk(child);
          return [child];
        }
        const raw = source.slice(
          child.position?.start.offset ?? 0,
          child.position?.end.offset ?? 0,
        );
        if (raw.includes('\\*')) return [child];
        const parts: any[] = [];
        let end = 0;
        for (const match of child.value.matchAll(/\*\*([^*\n]+)\*\*/g)) {
          // Restrict compatibility behavior to CJK prose with a complete balanced pair.
          if (!/[\u3000-\u9fff]/.test(match[1]) || /^\s|\s$/.test(match[1])) continue;
          parts.push({ type: 'text', value: child.value.slice(end, match.index) });
          parts.push({ type: 'strong', children: [{ type: 'text', value: match[1] }] });
          end = match.index + match[0].length;
        }
        return end ? [...parts, { type: 'text', value: child.value.slice(end) }] : [child];
      });
    }
    walk(tree);
  };
}
export function localMediaKind(url: string) {
  if (!url.startsWith('/api/conversations/') || url.includes('\\') || /[\r\n]/.test(url))
    return null;
  const path = url.split(/[?#]/)[0].toLowerCase();
  return /\.(mp4|webm)$/.test(path) ? 'video' : /\.(mp3|wav|ogg|m4a)$/.test(path) ? 'audio' : null;
}
export function previewDocument(source: string, resultToken?: string, layoutToken?: string) {
  const bridge =
    resultToken && /^[a-z0-9-]{1,80}$/i.test(resultToken)
      ? '<script>(()=>{const token=' +
        JSON.stringify(resultToken) +
        ';window.amadeus=Object.freeze({submitResult(result){try{const encoded=JSON.stringify(result);if(!encoded||encoded.length>20000)return false;parent.postMessage({type:"amadeus.preview.result",token,result},"*");return true;}catch{return false;}}});})();</script>'
      : '';
  const layout =
    layoutToken && /^[a-z0-9-]{1,80}$/i.test(layoutToken)
      ? '<script>(()=>{const token=' +
        JSON.stringify(layoutToken) +
        ';let queued=false,last=0;function report(){queued=false;const b=document.body;if(!b||!b.getClientRects().length)return;const r=b.getBoundingClientRect(),s=getComputedStyle(b);const height=Math.ceil(Math.max(b.scrollHeight,r.height)+Math.max(0,r.top)+parseFloat(s.marginBottom||0));if(height!==last){last=height;parent.postMessage({type:"amadeus.preview.size",token,height},"*");}}function queue(){if(!queued){queued=true;requestAnimationFrame(report);}}function start(){new ResizeObserver(queue).observe(document.body);new MutationObserver(queue).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});window.addEventListener("resize",queue);document.addEventListener("load",queue,true);document.fonts?.ready.then(queue);queue();}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start();})();</script>'
      : '';
  const policy =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return (
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' +
    policy +
    '">' +
    (layoutToken ? '<style>html{scrollbar-gutter:stable}</style>' : '') +
    bridge +
    source +
    layout
  );
}

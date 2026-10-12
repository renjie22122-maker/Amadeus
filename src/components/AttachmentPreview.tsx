import { useState } from 'react';
export function AttachmentPreview({
  attachment: a,
}: {
  attachment: { id: string; name: string; mime: string };
}) {
  const [failed, setFailed] = useState(false);
  const url = '/api/attachments/' + encodeURIComponent(a.id);
  return (
    <div className="local-media-attachment">
      {a.mime.startsWith('video/') ? (
        <video
          onError={() => setFailed(true)}
          controls
          playsInline
          preload="metadata"
          src={url + '?inline=1'}
          aria-label={a.name}
        />
      ) : a.mime.startsWith('audio/') ? (
        <audio
          onError={() => setFailed(true)}
          controls
          preload="metadata"
          src={url + '?inline=1'}
          aria-label={a.name}
        />
      ) : ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(a.mime) ? (
        <a href={url + '?preview=1'} target="_blank" rel="noopener noreferrer">
          <img src={url + '?preview=1'} alt={a.name} loading="lazy" />
        </a>
      ) : null}
      {failed && <small>无法预览，可下载查看 / Preview unavailable; download below.</small>}
      <a href={url} download={a.name}>
        {a.name}
      </a>
    </div>
  );
}

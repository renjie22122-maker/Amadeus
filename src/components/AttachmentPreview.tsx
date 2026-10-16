import { useState } from 'react';
import { Download, FileText } from 'lucide-react';
export function AttachmentPreview({
  attachment: a,
}: {
  attachment: {
    id: string;
    name: string;
    mime: string;
    bytes?: number;
    size?: number;
    sha256?: string;
  };
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
      <a className="file-download-card" href={url} download={a.name}>
        <FileText size={22} aria-hidden="true" />
        <span className="file-download-info">
          <strong>{a.name}</strong>
          <small>
            {a.name.split('.').pop()?.toUpperCase() || 'FILE'}
            {typeof (a.bytes ?? a.size) === 'number'
              ? ' · ' + new Intl.NumberFormat().format(a.bytes ?? a.size ?? 0) + ' B'
              : ''}
            {' · 下载 / Download'}
          </small>
        </span>
        <Download size={18} aria-hidden="true" />
      </a>
      {a.sha256 && (
        <details className="file-download-details">
          <summary>文件校验 / Checksum</summary>
          <code>SHA-256 {a.sha256}</code>
        </details>
      )}
    </div>
  );
}

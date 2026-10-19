import { useWorkbench } from '../workbench-context';
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
  const workbench = useWorkbench();
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
      {workbench ? (
        <div className="file-open-card">
          <button
            className="file-download-card"
            aria-label={'打开 / Open · ' + a.name}
            onClick={() => workbench(a)}
          >
            <FileText size={22} aria-hidden="true" />
            <span className="file-download-info">
              <strong>{a.name}</strong>
              <small>
                {a.name.split('.').pop()?.toUpperCase() || 'FILE'}
                {typeof (a.bytes ?? a.size) === 'number'
                  ? ' · ' + new Intl.NumberFormat().format(a.bytes ?? a.size ?? 0) + ' B'
                  : ''}
                {' · 打开 / Open'}
              </small>
            </span>
          </button>
          <a href={url} download={a.name} aria-label={'下载 / Download · ' + a.name}>
            <Download size={18} />
          </a>
        </div>
      ) : (
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
      )}
      {a.sha256 && (
        <details className="file-download-details">
          <summary>文件校验 / Checksum</summary>
          <code>SHA-256 {a.sha256}</code>
        </details>
      )}
    </div>
  );
}

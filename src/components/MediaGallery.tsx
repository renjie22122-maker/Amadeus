import { mediaCostLabel } from '../../shared/media-billing';
import { ModelPreview } from './ModelPreview';
import { useState } from 'react';
import { api } from '../api';
export function MediaGallery({ conversationId, jobs, zh, onText }: any) {
  const [error, setError] = useState('');
  if (!jobs.length) return null;
  const active = jobs.filter((j: any) =>
    ['queued', 'running', 'submitting'].includes(j.status),
  ).length;
  const transcriptionOnly = jobs.every((j: any) => j.kind === 'transcription');
  const title = transcriptionOnly
    ? zh
      ? '\u8bed\u97f3\u8f6c\u5199'
      : 'Transcriptions'
    : zh
      ? '\u5a92\u4f53\u4ea7\u7269'
      : 'Media outputs';
  return (
    <details className="media-gallery" aria-label={title} open>
      <summary className="media-gallery-summary">
        <strong>{title}</strong>
        <span>
          {jobs.length} {zh ? '\u9879' : 'items'}
        </span>
        {active > 0 && (
          <span role="status">
            {active} {zh ? '\u9879\u8fdb\u884c\u4e2d' : 'in progress'}
          </span>
        )}
        {error && <span>{zh ? '\u66f4\u65b0\u5931\u8d25' : 'Update failed'}</span>}
      </summary>
      {error && <p role="alert">{error}</p>}
      {jobs.map((j: any) => (
        <details key={j.id} className="media-job" open>
          <summary>
            <strong>
              {j.kind} · {j.model}
            </strong>
            <span>{j.status}</span>
            <small>{mediaCostLabel(j, zh)}</small>
          </summary>
          {j.prompt && <p>{j.prompt}</p>}
          {j.error && <p role="alert">{j.error}</p>}
          {j.outputs.map((f: any) => {
            const url =
              '/api/conversations/' + conversationId + '/media/' + j.id + '/files/' + f.id;
            return (
              <div className="media-output" key={f.id}>
                {f.preview ? (
                  <ModelPreview src={url} />
                ) : f.mime.startsWith('image/') ? (
                  <img loading="lazy" src={url} alt={j.prompt} />
                ) : f.mime.startsWith('video/') ? (
                  <video controls preload="metadata" src={url} />
                ) : f.mime.startsWith('audio/') ? (
                  <audio controls preload="metadata" src={url} />
                ) : null}
                {f.mime.startsWith('video/') && (
                  <small>
                    {f.inspection?.audio === 'absent'
                      ? zh
                        ? '源文件未检测到音轨；播放器无法恢复不存在的声音。'
                        : 'No audio track found in the source; playback cannot restore missing sound.'
                      : f.inspection?.audio === 'present'
                        ? zh
                          ? '源文件包含音轨；若无声，请检查播放器音量、系统音量与编解码兼容性。'
                          : 'Audio track present; check player/system volume and codec compatibility if silent.'
                        : zh
                          ? '音轨状态未核实；未自动转码或补配音。'
                          : 'Audio track status unverified; no automatic transcoding or dubbing.'}
                  </small>
                )}
                <a href={url} download={f.name}>
                  {zh ? '下载' : 'Download'} {f.name}
                </a>
              </div>
            );
          })}
          {j.text !== undefined && (
            <>
              <pre>{j.text}</pre>
              <button onClick={() => onText(j.text)}>
                {zh ? '插入草稿' : 'Insert into draft'}
              </button>
            </>
          )}
          {['queued', 'running'].includes(j.status) && (
            <button
              onClick={() =>
                void api(
                  '/conversations/' + conversationId + '/media/' + j.id + '/cancel',
                  {},
                ).catch((e) => setError(e.message))
              }
            >
              {zh ? '请求取消' : 'Request cancellation'}
            </button>
          )}
        </details>
      ))}
    </details>
  );
}

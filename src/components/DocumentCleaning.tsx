import { useState } from 'react';
import { cleanDocumentText, type CleaningOptions } from '../../shared/document-cleaning';
export function DocumentCleaning({
  text,
  onApply,
  zh,
}: {
  text: string;
  onApply: (text: string) => void;
  zh: boolean;
}) {
  const [options, setOptions] = useState<CleaningOptions>({});
  const [preview, setPreview] = useState<{ before: string; after: string }>();
  const [undo, setUndo] = useState<string>();
  const choices: [keyof CleaningOptions, string, string][] = [
    [
      'trailingSpaces',
      '清理行尾空格（可能影响 Markdown 硬换行）',
      'Trim trailing spaces (may affect Markdown hard breaks)',
    ],
    ['blankLines', '连续空行保留一行', 'Collapse repeated blank lines'],
    [
      'controlCharacters',
      '移除不可见控制字符（保留换行与制表符）',
      'Remove control characters (keep line breaks and tabs)',
    ],
  ];
  return (
    <details>
      <summary>{zh ? '清洗新版草稿' : 'Clean revision draft'}</summary>
      <p className="muted">
        {zh
          ? '对上方粘贴或编辑的新版正文操作；先预览，再应用到草稿，最后手动保存新版本。不会直接改原文、表格、页眉页脚或 OCR 内容。'
          : 'Operates on the revision text above. Preview, apply to draft, then save a new version manually. No automatic OCR correction or header/table removal.'}
      </p>
      {choices.map(([key, cn, en]) => (
        <label key={key}>
          <input
            type="checkbox"
            checked={!!options[key]}
            onChange={(e) => {
              setOptions({ ...options, [key]: e.target.checked });
              setPreview(undefined);
            }}
          />
          {zh ? cn : en}
        </label>
      ))}
      <button
        disabled={!text.trim()}
        onClick={() => setPreview({ before: text, after: cleanDocumentText(text, options) })}
      >
        {zh ? '预览清洗结果' : 'Preview cleanup'}
      </button>
      {preview && (
        <>
          <p>
            {preview.before.length} → {preview.after.length}{' '}
            {zh ? '字符；请核对差异' : 'characters; review changes'}
          </p>
          <div className="form-grid">
            <div>
              {zh ? '清洗前' : 'Before'}
              <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>
                {preview.before}
              </pre>
            </div>
            <div>
              {zh ? '清洗后' : 'After'}
              <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>
                {preview.after}
              </pre>
            </div>
          </div>
          <button
            disabled={
              text !== preview.before || preview.after === preview.before || !preview.after.trim()
            }
            onClick={() => {
              setUndo(text);
              onApply(preview.after);
              setPreview(undefined);
            }}
          >
            {zh ? '确认应用到草稿' : 'Apply to draft'}
          </button>
          {text !== preview.before && (
            <p>{zh ? '正文已变化，请重新预览。' : 'Text changed. Preview again.'}</p>
          )}
        </>
      )}
      {undo !== undefined && (
        <button
          onClick={() => {
            onApply(undo);
            setUndo(undefined);
            setPreview(undefined);
          }}
        >
          {zh ? '撤销本次清洗' : 'Undo cleanup'}
        </button>
      )}
    </details>
  );
}

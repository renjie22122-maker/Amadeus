import { useComposerHeight } from '../use-composer-height';
import { ModelControl } from './ModelControl';
import { AttachmentPreview } from './AttachmentPreview';
import { useState, useRef, useEffect } from 'react';
import { DraftPreview } from './DraftPreview';
import { shouldAttachPaste, hasMarkdown, insertPaste, pastedTextFilename } from '../composer-paste';
import { TaskProgress } from './TaskProgress';
import { SecurityControl } from './SecurityControl';
import { VoiceInput } from './VoiceInput';
import { TeamAutomationControls } from './TeamAutomationControls';
import { DelegationControl } from './DelegationControl';
import { ReasoningSlider } from './ReasoningSlider';
import { ArrowDown, ArrowUp, LoaderCircle, Plus, Square, X } from 'lucide-react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Conversation, Project, PublicProfile } from '../../shared/types';
import { api } from '../api';
import type { Action, ConversationDetail, RunView, UiState } from '../types';

interface ComposerProps {
  ensureConversation: () => Promise<string>;
  run: RunView | undefined;
  running: boolean | undefined;
  detail: ConversationDetail | null;
  send: (text?: string) => Promise<void>;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  drag: boolean;
  setDrag: Dispatch<SetStateAction<boolean>>;
  action: Action;
  removeAttachment: (id: string) => Promise<void>;
  addFiles: (files: FileList | File[]) => Promise<void>;
  draftRef: RefObject<HTMLTextAreaElement | null>;
  upload: RefObject<HTMLInputElement | null>;
  profile: PublicProfile | undefined;
  state: UiState;
  conversation: Conversation | undefined;
  update: (data: Record<string, unknown>, id?: string) => Promise<void>;
  onConfigureModels: () => void;
  project: Project | undefined;
  t: (key: string) => string;
  stick: RefObject<boolean>;
  bottom: RefObject<HTMLDivElement | null>;
  sending: boolean;
}
export function Composer({
  ensureConversation,
  onConfigureModels,
  run,
  running,
  detail,
  send,
  draft,
  setDraft,
  drag,
  setDrag,
  action,
  addFiles,
  removeAttachment,
  draftRef,
  upload,
  profile,
  state,
  conversation,
  update,
  project,
  t,
  stick,
  bottom,
  sending,
}: ComposerProps) {
  const modelBusy = useRef(false);
  const [modelSaving, setModelSaving] = useState(false);
  const zh = t('settings') !== 'Settings';
  const [preview, setPreview] = useState(false);
  useComposerHeight(draftRef, draft, preview);
  const [pasting, setPasting] = useState(false);
  useEffect(() => {
    if (!draft) setPreview(false);
  }, [draft]);
  const pasteBusy = useRef(false);
  const [pasteFailure, setPasteFailure] = useState('');
  const [pasteError, setPasteError] = useState('');
  async function attachText(text: string) {
    if (pasteBusy.current) return;
    pasteBusy.current = true;
    setPasting(true);
    setPasteError('');
    setPasteFailure('');
    try {
      await addFiles([new File([text], pastedTextFilename(text), { type: 'text/markdown' })]);
    } catch (error) {
      setPasteFailure(text);
      setPasteError(error instanceof Error ? error.message : String(error));
    } finally {
      pasteBusy.current = false;
      setPasting(false);
    }
  }
  const sendReady = (text?: string) => {
    if (!pasteBusy.current && !modelBusy.current) void send(text);
  };
  return (
    <div className="composer-area">
      <div className="composer-width">
        {detail && detail.conversation.id === conversation?.id && (
          <TaskProgress
            key={conversation.id + ':' + run?.id}
            detail={detail}
            run={run}
            zh={t('settings') !== 'Settings'}
            onInspect={(id) => {
              const target = document.getElementById('plan-task-' + id);
              if (target) {
                stick.current = false;
                const panel = target.closest('details');
                if (panel) panel.open = true;
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                target.focus({ preventScroll: true });
              }
            }}
          />
        )}
        {run && ['interrupted', 'failed'].includes(run.status) && (
          <button
            className="resume-button"
            disabled={sending || pasting || modelSaving}
            onClick={() =>
              void send(
                'Continue the unfinished task. Inspect existing results first. Do not replay completed or unknown side effects.',
              )
            }
          >
            ↻{' '}
            {detail?.unknownEffects.length
              ? t('settings') !== 'Settings'
                ? '只读检查并继续讨论'
                : 'Inspect safely and discuss'
              : t('resume')}
          </button>
        )}
        <div
          className={'composer ' + (drag ? 'dragging' : '')}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            void action(() => addFiles(e.dataTransfer.files));
          }}
        >
          {detail && detail.attachments.some((a) => !a.messageEventId) && (
            <div
              className="attachment-chips"
              role="region"
              aria-label={
                zh ? '待发送附件，可横向滚动' : 'Pending attachments, horizontally scrollable'
              }
              tabIndex={0}
            >
              {detail.attachments
                .filter((a) => !a.messageEventId)
                .map((a: any) => (
                  <span className="draft-attachment" key={a.id}>
                    <AttachmentPreview attachment={a} compact />
                    <button
                      type="button"
                      disabled={sending || pasting || modelSaving}
                      aria-label={
                        (t('settings') === 'Settings' ? 'Remove attachment: ' : '删除附件：') +
                        a.name
                      }
                      onClick={() => void action(() => removeAttachment(a.id))}
                    >
                      <X size={14} />
                    </button>
                  </span>
                ))}
            </div>
          )}
          <div className="draft-mode" role="group" aria-label={zh ? '草稿显示' : 'Draft display'}>
            <button
              type="button"
              aria-pressed={!preview}
              onClick={() => {
                setPreview(false);
                requestAnimationFrame(() => draftRef.current?.focus());
              }}
            >
              {zh ? '编辑' : 'Edit'}
            </button>
            <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
              {zh ? '预览' : 'Preview'}
            </button>
            {pasting && (
              <span role="status">{zh ? '正在保存粘贴文本…' : 'Saving pasted text…'}</span>
            )}
          </div>
          {pasteFailure && (
            <div className="draft-paste-error" role="alert">
              <p>
                {zh ? '附件保存失败，原文已保留：' : 'Attachment failed; original text retained: '}
                {pasteError}
              </p>
              <button
                type="button"
                disabled={pasting}
                onClick={() => void attachText(pasteFailure)}
              >
                {zh ? '重试' : 'Retry'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft((d) => d + pasteFailure);
                  setPasteFailure('');
                  setPreview(false);
                }}
              >
                {zh ? '放回草稿' : 'Restore to draft'}
              </button>
              <details>
                <summary>{zh ? '查看原文' : 'View original'}</summary>
                <pre>{pasteFailure}</pre>
              </details>
            </div>
          )}
          {preview && <DraftPreview text={draft} />}
          <textarea
            hidden={preview}
            ref={draftRef}
            aria-label="Message"
            value={draft}
            placeholder={running ? t('draft') : t('ask')}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const images = Array.from(e.clipboardData.files);
              if (images.length) {
                e.preventDefault();
                void action(() => addFiles(images));
                return;
              }
              const text = e.clipboardData.getData('text/plain');
              if (shouldAttachPaste(text)) {
                e.preventDefault();
                if (pasteBusy.current) {
                  setDraft((d) => d + text);
                  return;
                }
                void attachText(text);
              } else if (hasMarkdown(text)) {
                e.preventDefault();
                setDraft(
                  insertPaste(
                    draft,
                    text,
                    e.currentTarget.selectionStart,
                    e.currentTarget.selectionEnd,
                  ),
                );
                setPreview(true);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                sendReady();
              }
            }}
          />
          <div className="composer-controls">
            <div className="row minzero">
              <button
                className="icon"
                title={t('attachments')}
                onClick={() => upload.current?.click()}
              >
                <Plus size={20} />
              </button>
              <input
                hidden
                multiple
                ref={upload}
                type="file"
                onChange={(e) => {
                  if (e.target.files) void action(() => addFiles(e.target.files!));
                  e.target.value = '';
                }}
              />

              <ModelControl
                key={conversation?.id || 'new'}
                profiles={state.settings.profiles}
                profileId={conversation?.profileId || state.settings.defaultProfileId}
                policy={conversation?.subagentModels}
                locked={!!running || sending}
                zh={zh}
                onConfigure={onConfigureModels}
                onBusy={(busy) => {
                  modelBusy.current = busy;
                  setModelSaving(busy);
                }}
                onSave={async (patch) => {
                  const id = await ensureConversation();
                  await update(patch, id);
                }}
              />
              {conversation && (
                <>
                  <ReasoningSlider
                    label={t('reasoning')}
                    zh={t('settings') !== 'Settings'}
                    disabled={!!running}
                    value={conversation.reasoning}
                    efforts={profile?.efforts || ['auto']}
                    onChange={(reasoning) => void action(() => update({ reasoning }))}
                  />
                  <DelegationControl
                    mode={conversation.teamMode || 'auto'}
                    onModeChange={(teamMode) => void action(() => update({ teamMode }))}
                    management={
                      detail?.teamSpace ? (
                        <TeamAutomationControls
                          id={detail.teamSpace.id}
                          policy={detail.teamAutomation}
                          recovery={detail.teamRecovery || []}
                          events={detail.teamControlEvents || []}
                          zh={t('settings') !== 'Settings'}
                          action={action}
                        />
                      ) : undefined
                    }
                    value={conversation.teamStrategy || 'auto'}
                    disabled={!!running}
                    zh={t('settings') !== 'Settings'}
                    onChange={(teamStrategy) => void action(() => update({ teamStrategy }))}
                    depth={state.settings.maxAgentDepth}
                    total={state.settings.maxChildren}
                    parallel={state.settings.maxParallelRuns}
                  />
                  <SecurityControl
                    conversation={conversation}
                    settings={state.settings as any}
                    disabled={!!running}
                    zh={t('settings') !== 'Settings'}
                    onChange={(patch) => void action(() => update(patch))}
                  />
                </>
              )}
            </div>
            <div className="row">
              {running && run && detail?.teamSpace && (
                <button
                  onClick={() => void action(() => api('/runs/' + run.id + '/stop-member', {}))}
                >
                  {t('settings') !== 'Settings' ? '仅停止当前成员' : 'Stop this member only'}
                </button>
              )}
              {running && run && (
                <button
                  className="stop-button"
                  title={t('stop')}
                  onClick={() => void action(() => api('/runs/' + run.id + '/stop', {}))}
                >
                  <Square size={13} />
                </button>
              )}
              <VoiceInput
                key={conversation?.id || 'new'}
                conversationId={conversation?.id}
                ensureConversation={ensureConversation}
                enabled={!!state.settings.media?.transcriptionId}
                zh={t('settings') !== 'Settings'}
                onText={(text: string) => setDraft((d) => d + (d ? '\n' : '') + text)}
              />
              <button
                className="send-button"
                aria-label={
                  sending ? (t('settings') === 'Settings' ? 'Sending' : '正在发送') : t('send')
                }
                aria-busy={sending}
                title={
                  sending ? (t('settings') === 'Settings' ? 'Sending' : '正在发送') : t('send')
                }
                disabled={
                  sending ||
                  pasting ||
                  (!draft.trim() && !detail?.attachments.some((a) => !a.messageEventId)) ||
                  modelSaving ||
                  !state.settings.profiles.length
                }
                onClick={() => sendReady()}
              >
                {sending ? (
                  <LoaderCircle size={19} className="send-progress-icon" />
                ) : (
                  <ArrowUp size={19} />
                )}
              </button>
            </div>
          </div>
        </div>
        <div className="composer-foot">
          <span>
            {running
              ? t('draft')
              : project
                ? project.folders.length +
                  ' folder(s) · ' +
                  t(
                    conversation?.permission === 'auto'
                      ? t('settings') !== 'Settings'
                        ? '帮我审批'
                        : 'Approve for me'
                      : conversation?.permission === 'trusted'
                        ? 'trusted'
                        : conversation?.permission === 'read-only'
                          ? 'readOnly'
                          : 'askMode',
                  )
                : t('artifacts')}
          </span>
          <button
            title="Latest message"
            onClick={() => {
              stick.current = true;
              bottom.current?.scrollIntoView({ behavior: 'smooth' });
            }}
          >
            <ArrowDown size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

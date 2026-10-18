import { useEffect, useState } from 'react';
import { api } from '../api';
import { ScheduledTasks } from '../pages/ScheduledTasks';
export function ConversationSchedules({
  conversationId,
  state,
  zh,
  notify,
  openConversation,
}: any) {
  const [data, setData] = useState<any>({ schedules: [], commands: [] });
  const [error, setError] = useState('');
  const url = '/conversation-schedules?conversationId=' + encodeURIComponent(conversationId);
  const load = async () => {
    const next = await api(url);
    setData(next);
    setError('');
  };
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api(url, undefined, undefined, {}, controller.signal);
        if (!controller.signal.aborted) {
          setData(next);
          setError('');
        }
      } catch (e: any) {
        if (!controller.signal.aborted) setError(e.message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [url]);
  return (
    <section className="conversation-schedules">
      {error && <p role="status">{error}</p>}
      <details open={data.schedules.length ? true : undefined}>
        <summary>
          {zh ? '本对话的定时与后续任务' : 'Scheduled follow-ups in this chat'} ·{' '}
          {data.schedules.length}
        </summary>
        <ScheduledTasks
          state={state}
          schedules={data.schedules}
          commands={data.commands}
          conversationId={conversationId}
          zh={zh}
          notify={notify}
          reload={load}
          openConversation={openConversation}
        />
      </details>
    </section>
  );
}

import { useEffect, useRef } from 'react';
import { api } from './api';
export function useScheduleNotifications(notify: (text: string) => void, zh: boolean) {
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const rows = await api(
          '/schedule-notifications',
          undefined,
          undefined,
          {},
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const fresh = rows.filter((r: any) => !seen.current.has(r.id));
        rows.forEach((r: any) => seen.current.add(r.id));
        if (fresh.length)
          notify(
            zh
              ? `定时任务有 ${fresh.length} 条新通知，请在后台任务查看。`
              : `${fresh.length} scheduled-task notifications. See Background work.`,
          );
      } catch {
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 15000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [notify, zh]);
}

import { useEffect, useState } from 'react';
import { api } from '../api';
export function PersonalDot() {
  const [snapshot, setSnapshot] = useState<any>(),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const poll = () =>
      api('/personal')
        .then((s) => {
          if (live) {
            setSnapshot(s);
            setError('');
          }
        })
        .catch(() => {
          if (live) setError('连接中断 · 请检查电脑服务');
        });
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const active = snapshot?.goals.filter((g: any) => g.task?.enabled).length || 0;
  return (
    <div className="personal-dot">
      <div className="personal-dot-orb" aria-hidden="true">
        A
      </div>
      <strong>{snapshot?.identity?.name || 'Amadeus'}</strong>
      <span role="status">{error || `${active} 个目标持续跟进中`}</span>
      <button
        onClick={() =>
          (
            window as Window & { amadeusDesktop?: { openAgent?: () => void } }
          ).amadeusDesktop?.openAgent?.()
        }
      >
        打开常驻助手
      </button>
    </div>
  );
}

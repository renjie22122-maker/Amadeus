import { useEffect, useState } from 'react';
import { api } from '../api';
import './TokenActivity.css';
export function TokenActivity({ zh }: { zh: boolean }) {
  const [open, setOpen] = useState(false),
    [year, setYear] = useState(new Date().getFullYear()),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  const [selected, setSelected] = useState('');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setData(null);
    setSelected('');
    setError('');
    api(
      '/token-activity?year=' + year + '&timeZone=' + encodeURIComponent(timeZone),
      undefined,
      undefined,
      {},
      abort.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [open, year, timeZone, reload]);
  const number = (n: number) => n.toLocaleString(zh ? 'zh-CN' : 'en-US');
  const start = new Date(Date.UTC(year, 0, 1)),
    end = Date.UTC(year + 1, 0, 1),
    cells = [];
  const byDate = new Map<string, any>((data?.days || []).map((d: any) => [d.date, d]));
  const max = Math.max(1, ...(data?.days || []).map((d: any) => d.input + d.output));
  for (let n = 0; n < start.getUTCDay(); n++) cells.push(<span key={'pad' + n} />);
  for (let t = start.getTime(); t < end; t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10),
      d = byDate.get(date),
      tokens = d ? d.input + d.output : 0;
    const label =
      date +
      ' · ' +
      number(tokens) +
      ' tokens · ' +
      number(d?.calls || 0) +
      (zh ? ' 次模型调用' : ' model calls') +
      (d?.unreported ? ' · ' + d.unreported + (zh ? ' 次用量未报告' : ' unreported') : '');
    const level = tokens ? Math.min(4, Math.max(1, Math.ceil((tokens / max) * 4))) : 0;
    cells.push(
      <button
        key={date}
        type="button"
        className={'token-day level-' + level + (selected === label ? ' is-selected' : '')}
        title={label}
        aria-label={label}
        onClick={() => setSelected(label)}
        onFocus={() => setSelected(label)}
        onMouseEnter={() => setSelected(label)}
      />,
    );
  }
  const total = data?.total;
  return (
    <section className="panel token-activity">
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <span className="token-heading-icon" aria-hidden="true">
            ▦
          </span>
          <strong>{zh ? 'Token 活动与用量洞察' : 'Token activity & insights'}</strong>
          <span className="token-heading-note">
            {zh ? '逐日了解你的 AI 使用习惯' : 'Your AI usage, day by day'}
          </span>
        </summary>
        <div className="token-controls">
          <label>
            {zh ? '年份' : 'Year'}{' '}
            <input
              aria-label={zh ? '统计年份' : 'Activity year'}
              type="number"
              min={2000}
              max={2200}
              value={year}
              onChange={(e) => {
                const y = Number(e.target.value);
                if (y >= 2000 && y <= 2200) setYear(y);
              }}
            />
          </label>
          <span>{timeZone}</span>
          <button onClick={() => setReload((x) => x + 1)}>{zh ? '刷新' : 'Refresh'}</button>
        </div>
        {error ? (
          <p role="alert">{error}</p>
        ) : !data ? (
          <p role="status">{zh ? '正在读取用量记录…' : 'Loading usage records…'}</p>
        ) : (
          <>
            <div className="token-chart-heading">
              <div>
                <span className="token-eyebrow">{zh ? '年度活动' : 'ANNUAL ACTIVITY'}</span>
                <h3>
                  {number(total.input + total.output)} <small>tokens</small>
                </h3>
              </div>
              <span className="token-active-days">
                {data.days.filter((d: any) => d.calls > 0).length} {zh ? '个活跃日' : 'active days'}
              </span>
            </div>
            <div className="token-calendar-scroll">
              <div className="token-months">
                {Array.from({ length: 12 }, (_, i) => (
                  <span
                    key={i}
                    style={{
                      left:
                        Math.floor(
                          ((Date.UTC(year, i, 1) - start.getTime()) / 86400000 +
                            start.getUTCDay()) /
                            7,
                        ) * 15,
                    }}
                  >
                    {new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en', {
                      month: 'short',
                      timeZone: 'UTC',
                    }).format(new Date(Date.UTC(year, i, 1)))}
                  </span>
                ))}
              </div>
              <div
                className="token-calendar"
                aria-label={zh ? '每日 Token 活动' : 'Daily token activity'}
              >
                {cells}
              </div>
            </div>
            <div className="token-legend">
              <span>{zh ? '少' : 'Less'}</span>
              {[0, 1, 2, 3, 4].map((level) => (
                <i key={level} className={'token-day level-' + level} aria-hidden="true" />
              ))}
              <span>{zh ? '多' : 'More'}</span>
              <span className="token-scale-note">
                {zh ? '按所选年份峰值分为 4 档' : '4 bands relative to the year’s peak'}
              </span>
            </div>
            <p className="token-day-detail" aria-live="polite">
              {selected ||
                (zh
                  ? '悬停、聚焦或点击日期查看每日用量；颜色越深，用量越高'
                  : 'Hover, focus or select a day for usage; darker means more tokens')}
            </p>
            <div className="token-insights">
              <article>
                <small>{zh ? '已报告 Token' : 'Reported tokens'}</small>
                <strong>{number(total.input + total.output)}</strong>
                <span>
                  {zh ? '输入 / 输出' : 'Input / output'}: {number(total.input)} /{' '}
                  {number(total.output)}
                </span>
              </article>
              <article>
                <small>{zh ? '输入缓存命中' : 'Input cache hits'}</small>
                <strong>
                  {total.input ? ((100 * total.cached) / total.input).toFixed(1) + '%' : '—'}
                </strong>
                <span>{number(total.cached)} tokens</span>
              </article>
              <article>
                <small>{zh ? '已知部分估算费用' : 'Known estimated cost'}</small>
                <strong>${total.estimatedUsd.toFixed(5)}</strong>
                <span>
                  {total.unpriced + total.unreported}{' '}
                  {zh ? '次调用费用不完整' : 'calls with incomplete cost'}
                </span>
              </article>
              <article>
                <small>{zh ? '模型调用 / 运行' : 'Model calls / runs'}</small>
                <strong>
                  {number(total.calls)} / {number(data.runs)}
                </strong>
                <span>
                  {total.unreported} {zh ? '次用量未报告' : 'usage reports missing'}
                </span>
              </article>
              <article>
                <small>{zh ? '最常用推理设置' : 'Most used reasoning setting'}</small>
                <strong>{data.reasoning[0]?.name || '—'}</strong>
                <span>
                  {data.runs && data.reasoning[0]
                    ? ((100 * data.reasoning[0].count) / data.runs).toFixed(1) + '%'
                    : ''}
                </span>
              </article>
              <article>
                <small>{zh ? '探索技能 / 读取记录' : 'Skills explored / read records'}</small>
                <strong>
                  {data.skillsExplored} / {data.skillReads}
                </strong>
                <span>
                  {zh ? '按运行、技能及资源去重' : 'Unique run, skill and resource records'}
                </span>
              </article>
            </div>
            <div className="token-rankings">
              <div>
                <h3>{zh ? '常用模型' : 'Top models'}</h3>
                {data.models.slice(0, 5).map((x: any) => (
                  <div className="token-rank-row" key={x.name}>
                    <span>{x.name}</span>
                    <strong>{number(x.count)}</strong>
                    <meter
                      min={0}
                      max={Math.max(1, data.models[0]?.count || 0)}
                      value={x.count}
                      aria-label={x.name}
                    />
                  </div>
                ))}
              </div>
              <div>
                <h3>{zh ? 'MCP 调用尝试' : 'MCP call attempts'}</h3>
                {data.plugins.length ? (
                  data.plugins.slice(0, 5).map((x: any) => (
                    <div className="token-rank-row" key={x.name}>
                      <span>{x.name}</span>
                      <strong>{number(x.count)}</strong>
                      <meter
                        min={0}
                        max={Math.max(1, data.plugins[0]?.count || 0)}
                        value={x.count}
                        aria-label={x.name}
                      />
                    </div>
                  ))
                ) : (
                  <p>{zh ? '暂无记录' : 'No records'}</p>
                )}
              </div>
            </div>
            <p className="muted">
              {zh
                ? '统计主对话与子代理的独立模型请求，不重复累加运行汇总。缓存是输入的一部分。费用为历史单价估算，不是账单；后台提取、审核及媒体服务未纳入此模型请求账本。Fast Mode 未记录，不推测。'
                : 'Counts independent parent and child model requests, not cumulative run totals. Cache tokens are part of input. Historical price estimates are not invoices; background extraction, reviews and media are outside this request ledger. Fast Mode is not recorded.'}
            </p>
          </>
        )}
      </details>
    </section>
  );
}

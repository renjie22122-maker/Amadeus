export function ContextUsage({ data, zh }: { data: any; zh: boolean }) {
  const b = data.budget,
    tokens = b?.tokens || 0,
    capacity = b?.capacity || 0,
    threshold = b?.threshold || 0,
    percent = capacity ? (tokens / capacity) * 100 : 0;
  const label =
    b?.method === 'measured'
      ? zh
        ? 'API 实测'
        : 'API measured'
      : b?.method === 'calibrated'
        ? zh
          ? 'API 校准估算（包含新增内容）'
          : 'API-calibrated estimate including new content'
        : zh
          ? '本地估算（尚无有效实测）'
          : 'Local estimate; no valid measurement yet';
  return (
    <section className="context-usage">
      <strong>{zh ? '上下文用量' : 'Context usage'}</strong>
      <p>{label}</p>
      <b>
        {tokens.toLocaleString()} / {capacity.toLocaleString()} tokens · {percent.toFixed(1)}%
      </b>
      <div
        className="context-usage-track"
        role="meter"
        aria-label={zh ? '上下文 token 占用' : 'Context token usage'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, percent)}
      >
        <span style={{ width: Math.min(100, percent) + '%' }} />
        {capacity > 0 && <i style={{ left: Math.min(100, (threshold / capacity) * 100) + '%' }} />}
      </div>
      <p>
        {zh ? '红线：压缩阈值' : 'Red marker: compaction threshold'} {threshold.toLocaleString()}{' '}
        tokens ({capacity ? ((threshold / capacity) * 100).toFixed(1) : 0}%)
      </p>
      <small>
        {zh ? '已预留输出与安全余量' : 'Output and safety reserve'}:{' '}
        {((b?.reserve || 0) + (b?.margin || 0)).toLocaleString()} tokens.{' '}
        {zh
          ? '新增内容、工具定义和图片计入估算。达到红线后在下一次请求前尝试压缩；估算不是精确 tokenizer 计数。'
          : 'New content, tool definitions and images are estimated. Compression is attempted before the next request at the red marker. Estimates are not exact tokenizer counts.'}
      </small>

      <p className="inspection-note">
        {zh ? '当前保存快照：' : 'Saved snapshot: '}
        {tokens >= threshold && threshold > 0
          ? zh
            ? '已达到阈值；下一次模型请求前检查压缩，不会中断正在生成的回复。'
            : 'At threshold; checked before the next model request, not during an in-flight response.'
          : zh
            ? '尚未达到压缩阈值。'
            : 'Below the compaction threshold.'}
        {data.lastCompactionCheck && (
          <>
            <br />
            {zh ? '后台最近检查：' : 'Latest runtime check: '}
            {new Date(data.lastCompactionCheck.checkedAt).toLocaleTimeString()} ·{' '}
            {data.lastCompactionCheck.tokens.toLocaleString()} /{' '}
            {data.lastCompactionCheck.threshold.toLocaleString()} tokens ·{' '}
            {data.lastCompactionCheck.required
              ? zh
                ? '达到阈值（不代表压缩已成功）'
                : 'Threshold reached (not proof of successful compaction)'
              : zh
                ? '未达阈值'
                : 'Below threshold'}
          </>
        )}
      </p>

      {(data.cache || data.cognitive) && (
        <details>
          <summary>{zh ? '缓存与运行观察' : 'Cache and runtime observations'}</summary>
          {data.cache && (
            <>
              <p>
                {zh ? '最近请求缓存输入' : 'Cached input in latest request'}:{' '}
                {data.cache.cachedTokens?.toLocaleString() ?? '—'} /{' '}
                {data.cache.inputTokens?.toLocaleString() ?? '—'} tokens
                {data.cache.cacheRatio != null
                  ? ' · ' + (data.cache.cacheRatio * 100).toFixed(1) + '%'
                  : ''}
              </p>
              <p>
                {zh ? '与上次请求比较' : 'Compared with previous request'}:{' '}
                {!data.cache.baseline
                  ? zh
                    ? '尚无基线'
                    : 'No baseline yet'
                  : [
                      data.cache.routeChanged
                        ? zh
                          ? '模型路由变化'
                          : 'Model route changed'
                        : null,
                      data.cache.systemChanged
                        ? zh
                          ? '固定提示词变化'
                          : 'System prefix changed'
                        : null,
                      data.cache.toolsChanged
                        ? zh
                          ? '工具定义变化'
                          : 'Tool schemas changed'
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' / ') ||
                    (zh
                      ? '模型、固定提示词及工具定义未变'
                      : 'Model, system prefix and tool schemas unchanged')}
              </p>
              <small>
                {zh
                  ? '这里只记录变化和 API 用量，不保证缓存命中，也不能据此确定未命中的原因。'
                  : 'These are changes and API usage, not a cache guarantee or proof of why a request missed the cache.'}
              </small>
              <ul>
                {Object.entries(data.cache.characters || {}).map(([key, value]) => (
                  <li key={key}>
                    {
                      (
                        {
                          instructions: zh ? '固定指令' : 'Instructions',
                          runtime: zh ? '运行信息' : 'Runtime context',
                          toolResults: zh ? '工具结果' : 'Tool results',
                          conversation: zh ? '对话' : 'Conversation',
                          toolSchemas: zh ? '工具定义' : 'Tool schemas',
                        } as Record<string, string>
                      )[key]
                    }
                    : {Number(value).toLocaleString()} {zh ? '字符' : 'characters'}
                  </li>
                ))}
              </ul>
            </>
          )}
          {data.cognitive && (
            <p>
              {zh ? '运行观察' : 'Runtime observations'}: {zh ? '受阻任务' : 'Blocked tasks'}{' '}
              {data.cognitive.signals.blockedTasks} · {zh ? '待验证' : 'Pending verification'}{' '}
              {data.cognitive.signals.pendingVerification} ·{' '}
              {zh ? '本批工具错误' : 'Tool errors in latest batch'}{' '}
              {data.cognitive.signals.toolErrors}
              <br />
              <small>
                {zh
                  ? '这是记录状态，不是模型信心或正确性评分。'
                  : 'These are recorded states, not confidence or correctness scores.'}
              </small>
            </p>
          )}
        </details>
      )}
    </section>
  );
}

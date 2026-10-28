import { useState } from 'react';
import { api } from '../api';
type Entry = {
  id: string;
  reference: string;
  name: string;
  tags: string[];
  available: boolean;
  native?: { state: string };
};
type Library = { items: Entry[]; total: number; capabilities: { favoritesImport: boolean } };
export function ChatStickerLibrary({
  id,
  zh,
  notify,
}: {
  id: string;
  zh: boolean;
  notify: (s: string) => void;
}) {
  const [data, setData] = useState<Library>(),
    [query, setQuery] = useState(''),
    [offset, setOffset] = useState(0),
    [busy, setBusy] = useState(false);
  const [count, setCount] = useState(48);
  const [reference, setReference] = useState(''),
    [name, setName] = useState(''),
    [tags, setTags] = useState('');
  const base = '/chat-connections/' + encodeURIComponent(id) + '/stickers';
  async function load(start = offset) {
    try {
      setData(await api(base + '?query=' + encodeURIComponent(query) + '&offset=' + start));
      setOffset(start);
    } catch (e) {
      notify(String(e));
    }
  }
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="chat-sticker-library"
      onToggle={(e) => {
        if (e.currentTarget.open && !data) void load(0);
      }}
    >
      <summary>{zh ? '表情库 · 仅此会话' : 'Sticker library · this chat only'}</summary>
      <p>
        {!data?.capabilities.favoritesImport
          ? zh
            ? '保存本会话表情并复用本地图片。标签不代替看图。'
            : 'Save local stickers for this chat. Labels do not replace inspecting images.'
          : zh
            ? 'QQ 中保存到「表情 → 我的收藏」，本地库保留缓存。发送优先读取 QQ 收藏，失败用缓存。名称和标签便于检索，不代表模型已经看过图片。'
            : 'Save to QQ favorite stickers, retaining a local cache. Delivery prefers QQ favorites with local fallback. Labels do not replace inspecting images.'}
      </p>
      <div className="row">
        <input
          aria-label={zh ? '搜索表情' : 'Search stickers'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={zh ? '搜索名称或标签' : 'Search names or tags'}
        />
        <button onClick={() => void load(0)}>{zh ? '搜索／刷新' : 'Search / refresh'}</button>
      </div>
      {data?.capabilities.favoritesImport && (
        <div>
          <label>
            {zh ? '收藏读取数量' : 'Favorites count'}
            <input
              type="number"
              min={1}
              max={200}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const result = await api(base + '/import-favorites', { count });
                notify(
                  zh
                    ? '收藏导入已开始；稍后刷新查看进度'
                    : 'Favorites import started; refresh for status',
                );
                return result;
              })
            }
          >
            {zh ? '导入机器人 QQ 收藏到本会话' : 'Import bot QQ favorites into this chat'}
          </button>
        </div>
      )}
      <button
        disabled={busy}
        onClick={() =>
          void action(async () => {
            const r = await api(base + '/import-status');
            notify(
              r.status === 'completed'
                ? zh
                  ? `导入完成 ${r.result.imported.length}，失败 ${r.result.failed}`
                  : `Imported ${r.result.imported.length}, failed ${r.result.failed}`
                : r.error || r.status,
            );
          })
        }
      >
        {zh ? '查看收藏导入进度' : 'Check favorites import'}
      </button>
      <small>
        {zh
          ? '默认读取 48 张，可调整至 200 张，重复图片去重；桥接服务可能仅返回部分收藏。不支持订阅表情商店和 QQ 空间发布。'
          : 'Reads 48 favorites by default, adjustable up to 200, deduplicated. The bridge may return only part of the collection. Subscription packs and Qzone publishing are unsupported.'}
      </small>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))',
          gap: 12,
          margin: '12px 0',
        }}
      >
        {data?.items.map((x) => (
          <article
            key={x.id}
            style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8, minWidth: 0 }}
          >
            {x.available ? (
              <img
                alt={x.name}
                loading="lazy"
                src={'/api/attachments/' + x.reference.slice(11)}
                style={{ width: '100%', height: 110, objectFit: 'contain' }}
              />
            ) : (
              <p>{zh ? '原文件不可用，请重新导入' : 'File missing; reimport'}</p>
            )}
            <strong style={{ overflowWrap: 'anywhere' }}>{x.name}</strong>
            <p>{x.tags.join(' · ')}</p>
            <small>
              {x.native?.state === 'confirmed'
                ? zh
                  ? 'QQ 表情 · 我的收藏已确认'
                  : 'QQ favorite confirmed'
                : x.native?.state === 'unconfirmed'
                  ? zh
                    ? 'QQ 收藏待核对 · 本地已缓存'
                    : 'QQ addition unconfirmed; cached locally'
                  : x.native?.state === 'failed'
                    ? zh
                      ? 'QQ 收藏失败 · 本地已缓存'
                      : 'QQ collection failed; cached locally'
                    : zh
                      ? '本地表情'
                      : 'Local sticker'}
            </small>
            <button
              onClick={() => {
                setReference(x.reference);
                setName(x.name);
                setTags(x.tags.join(', '));
              }}
            >
              {zh ? '编辑' : 'Edit'}
            </button>
            <button
              disabled={busy}
              onClick={() => void action(() => api(base + '/' + x.id, undefined, 'DELETE'))}
            >
              {zh ? '移出表情库' : 'Remove from library'}
            </button>
          </article>
        ))}
      </div>
      <div className="row">
        <button disabled={!offset} onClick={() => void load(Math.max(0, offset - 24))}>
          {zh ? '上一页' : 'Previous'}
        </button>
        <span>
          {data?.total || 0} {zh ? '张' : 'stickers'}
        </span>
        <button
          disabled={!data || offset + 24 >= data.total}
          onClick={() => void load(offset + 24)}
        >
          {zh ? '下一页' : 'Next'}
        </button>
      </div>
      <details>
        <summary>{zh ? '添加／编辑已导入图片' : 'Add / edit imported image'}</summary>
        <input
          aria-label="attachment reference"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="attachment:…"
        />
        <input
          aria-label="sticker name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={zh ? '名称' : 'Name'}
        />
        <input
          aria-label="sticker tags"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder={zh ? '标签，以逗号分隔' : 'Comma-separated tags'}
        />
        <button
          disabled={busy || !reference || !name}
          onClick={() =>
            void action(() =>
              api(base, {
                reference,
                name,
                tags: tags
                  .split(/[,，]/)
                  .map((x) => x.trim())
                  .filter(Boolean),
              }),
            )
          }
        >
          {zh ? '保存' : 'Save'}
        </button>
      </details>
      <small>
        {zh
          ? '移出本地库不会删除 QQ 收藏或原聊天附件。QQ 收藏属于机器人账号；仅收藏适合复用的表情，不收私人照片。模型可按需收藏已看过的合适图片；不会自动收集所有群图片。'
          : 'Removal preserves the original attachment. The model can save suitable inspected images, without collecting every group image.'}
      </small>
    </details>
  );
}

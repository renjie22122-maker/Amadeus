import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { visibleEntries } from '../sidebar-lists';
export function SidebarList<T extends { id: string; pinned?: boolean }>({
  items,
  initial,
  selected,
  searching,
  zh,
  render,
  nested = false,
  label,
}: {
  items: T[];
  initial: number;
  selected?: string;
  searching: boolean;
  zh: boolean;
  render: (item: T) => ReactNode;
  nested?: boolean;
  label: string;
}) {
  const [extra, setExtra] = useState(0);
  const limit = initial + extra;
  const visible = searching ? items : visibleEntries(items, limit, selected);
  const remaining = items.length - visible.length;
  return (
    <div className={nested ? 'sidebar-list nested' : 'sidebar-list'}>
      <div className="sidebar-list-items">
        {visible.map(render)}
        {!items.length && <div className="sidebar-empty">{zh ? '暂无内容' : 'No items'}</div>}
      </div>
      {!searching && (remaining > 0 || limit > initial) && (
        <div className="sidebar-list-controls">
          {remaining > 0 && (
            <button
              aria-label={label + (zh ? '：显示更多' : ': See more')}
              onClick={() => setExtra((n) => n + initial)}
            >
              <ChevronDown size={13} />
              {zh ? '显示更多' : 'See more'} <span>({remaining})</span>
            </button>
          )}
          {limit > initial && (
            <button aria-label={label + (zh ? '：收起' : ': See less')} onClick={() => setExtra(0)}>
              <ChevronUp size={13} />
              {zh ? '收起' : 'See less'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

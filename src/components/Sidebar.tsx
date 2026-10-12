import { useEffect, useRef, useState } from 'react';
import { SidebarList } from './SidebarList';
import { recentChats, recentProjects } from '../sidebar-lists';
import {
  Archive,
  ChevronRight,
  BookOpen,
  Brain,
  Folder,
  FolderPlus,
  Library as LibraryIcon,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  Sparkles,
  Sun,
} from 'lucide-react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { Conversation, Project } from '../../shared/types';
import { type Language } from '../i18n';
import type { Action, UiState } from '../types';

interface SidebarProps {
  selected: string;
  editProject: (project: Project) => void;
  t: (key: string) => string;
  state: UiState;
  setSidebar: Dispatch<SetStateAction<boolean>>;
  action: Action;
  newChat: (projectId?: string | null) => Promise<string>;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  setProjectDialog: Dispatch<SetStateAction<boolean>>;
  archived: boolean;
  setArchived: Dispatch<SetStateAction<boolean>>;
  filtered: Conversation[];
  chatLink: (c: Conversation) => ReactNode;
  page: string;
  setPage: Dispatch<SetStateAction<string>>;
  language: Language;
  setLanguage: Dispatch<SetStateAction<Language>>;
  theme: string;
  setTheme: Dispatch<SetStateAction<string>>;
}
export function Sidebar({
  selected,
  editProject,
  t,
  state,
  setSidebar,
  action,
  newChat,
  query,
  setQuery,
  setProjectDialog,
  archived,
  setArchived,
  filtered,
  chatLink,
  page,
  setPage,
  language,
  setLanguage,
  theme,
  setTheme,
}: SidebarProps) {
  const navRef = useRef<HTMLElement>(null);
  const [initialCount, setInitialCount] = useState(2);
  useEffect(() => {
    const node = navRef.current;
    if (!node) return;
    const resize = () =>
      setInitialCount(Math.max(1, Math.min(5, Math.floor((node.clientHeight / 2 - 72) / 44))));
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    return () => observer.disconnect();
  }, []);
  const chats = recentChats(filtered);
  const searching = !!query.trim();
  const projects = recentProjects(
    state.projects.filter(
      (p) =>
        (!p.removedAt || archived) &&
        (!searching ||
          p.name.toLowerCase().includes(query.toLowerCase()) ||
          chats.some((c) => c.projectId === p.id)),
    ),
    state.conversations,
  );
  const selectedProject =
    state.conversations.find((c) => c.id === selected)?.projectId || undefined;
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-icon">
          <Sparkles size={20} />
        </div>
        <strong>
          {t('Amadeus')}
          <span>{t('YOUR LOCAL WORKSPACE')}</span>
        </strong>
        <button className="icon" title="Hide sidebar" onClick={() => setSidebar(false)}>
          <PanelLeftClose size={18} />
        </button>
      </div>
      <button className="new-chat" onClick={() => void action(() => newChat())}>
        <Plus size={18} />
        {t('newChat')}
        <kbd>＋</kbd>
      </button>
      <div className="search">
        <Search size={15} />
        <input
          aria-label={t('search')}
          placeholder={t('search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <nav className="chat-navigation" ref={navRef}>
        <div className="nav-heading">
          <span>{t('projects')}</span>
          <button title={t('addProject')} onClick={() => setProjectDialog(true)}>
            <Plus size={15} />
          </button>
        </div>
        <SidebarList
          items={projects}
          initial={initialCount}
          selected={selectedProject}
          searching={searching}
          zh={language === 'zh'}
          label={t('projects')}
          render={(p) => (
            <details
              className="project-group"
              key={p.id}
              open={searching || p.id === selectedProject}
            >
              <summary>
                <ChevronRight size={12} className="project-chevron" />
                <Folder size={15} />
                <span>
                  {p.name}
                  {p.removedAt ? (language === 'zh' ? ' · 已移除' : ' · Removed') : ''}
                </span>
                <button
                  title={language === 'zh' ? '管理工作区' : 'Manage workspace'}
                  onClick={(e) => {
                    e.preventDefault();
                    editProject(p);
                  }}
                >
                  <MoreHorizontal size={14} />
                </button>
                <button
                  title={t('newChat')}
                  disabled={!!p.removedAt}
                  onClick={(e) => {
                    e.preventDefault();
                    void action(() => newChat(p.id));
                  }}
                >
                  <Plus size={14} />
                </button>
              </summary>
              <SidebarList
                nested
                items={chats.filter((c) => c.projectId === p.id)}
                initial={5}
                selected={selected}
                searching={searching}
                zh={language === 'zh'}
                label={p.name}
                render={chatLink}
              />
            </details>
          )}
        />
        {!state.projects.length && (
          <button className="add-project" onClick={() => setProjectDialog(true)}>
            <FolderPlus size={15} />
            {t('addProject')}
          </button>
        )}
        <div className="nav-heading">
          <span>{archived ? t('archiveView') : t('chats')}</span>
          <button title={t('archiveView')} onClick={() => setArchived(!archived)}>
            <Archive size={14} />
          </button>
        </div>
        <SidebarList
          items={chats.filter((c) => !c.projectId)}
          initial={5}
          selected={selected}
          searching={searching}
          zh={language === 'zh'}
          label={t('chats')}
          render={chatLink}
        />
      </nav>
      <div className="sidebar-tools">
        {[
          ['knowledge', LibraryIcon],
          ['skills', BookOpen],
          ['memory', Brain],
          ['background', LibraryIcon],
          ['settings', Settings],
        ].map(([key, Icon]: any) => (
          <button className={page === key ? 'selected' : ''} key={key} onClick={() => setPage(key)}>
            <Icon size={17} />
            {t(key)}
          </button>
        ))}
      </div>
      <div className="sidebar-bottom">
        <span className="local-status">
          <i />
          {t('Local')}
        </span>
        <button title={t('language')} onClick={() => setLanguage(language === 'en' ? 'zh' : 'en')}>
          {language === 'en' ? '中文' : 'EN'}
        </button>
        <button title={t('theme')} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
    </aside>
  );
}

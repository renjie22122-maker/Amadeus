import type { UiState } from '../types';
import { workspaceNavigation } from '../workspace-navigation';

export function WorkspacePage({
  page,
  state,
  zh,
  navigate,
  createProject,
  openProject,
  review,
}: {
  page: string;
  state: UiState;
  zh: boolean;
  navigate: (page: string) => void;
  createProject: () => void;
  openProject: (id: string) => void;
  review: (id: string) => void;
}) {
  const entry = workspaceNavigation.find((item) => item.id === page);
  const text = (en: string, cn: string) => (zh ? cn : en);
  const link = (id: string, en: string, cn: string) => (
    <button onClick={() => navigate(id)}>{text(en, cn)}</button>
  );
  return (
    <section className="workspace-hub">
      <h1>{entry ? (zh ? entry.zh : entry.en) : page}</h1>
      <p>{entry && (zh ? entry.detail : entry.description)}</p>
      {page === 'siteMap' && (
        <div className="workspace-grid">
          {workspaceNavigation
            .filter((item) => item.id !== 'siteMap')
            .map((item) => (
              <button key={item.id} onClick={() => navigate(item.id)}>
                <strong>{zh ? item.zh : item.en}</strong>
                <span>{zh ? item.detail : item.description}</span>
              </button>
            ))}
          {link('knowledge', 'Knowledge library', '知识库')}
          {link('memory', 'Memory', '记忆')}
          {link('chatConnections', 'Messaging channels', '消息渠道')}
          {link('settings', 'Settings', '设置')}
        </div>
      )}
      {(page === 'spaces' || page === 'codeReview') && (
        <>
          {page === 'codeReview' && (
            <p>
              {text(
                'Choose a project to prepare a review request. Inspect the request before sending; reviews use your configured model and tools, not an external review service.',
                '选择项目准备审查请求。发送前可以编辑；审查使用已配置的模型与工具，并非外部审查服务。',
              )}
            </p>
          )}
          <button onClick={createProject}>{text('New workspace', '新建工作空间')}</button>
          <div className="workspace-grid">
            {state.projects
              .filter((p) => !p.removedAt)
              .map((project) => (
                <article className="panel" key={project.id}>
                  <h2>{project.name}</h2>
                  <p>
                    {state.conversations.filter((c) => c.projectId === project.id).length}{' '}
                    {text('conversations', '个会话')}
                  </p>
                  <button
                    onClick={() =>
                      page === 'codeReview' ? review(project.id) : openProject(project.id)
                    }
                  >
                    {page === 'codeReview'
                      ? text('Prepare review', '准备审查')
                      : text('New conversation', '新建会话')}
                  </button>
                </article>
              ))}
          </div>
          {!state.projects.some((p) => !p.removedAt) && (
            <p>
              {text(
                'Create a workspace first to give the agent project context.',
                '请先创建工作空间，为 Agent 提供项目背景。',
              )}
            </p>
          )}
        </>
      )}
      {page === 'plugins' && (
        <>
          <section className="panel">
            <h2>MCP</h2>
            <p>
              {text(
                'Manage servers, authorization and tool access in Settings. A configured server must be enabled and connected before its capabilities are available.',
                '在设置中管理服务、授权与工具权限。已配置服务需要启用并成功连接后才能使用。',
              )}
            </p>
            <p>
              {state.settings.mcp.length} {text('configured servers', '个已配置服务')}
            </p>
            {link('settings', 'Configure MCP', '配置 MCP')}
          </section>
          <section className="panel">
            <h2>{text('Skill packages', '技能包')}</h2>
            <p>
              {text(
                'Install and manage reusable agent instructions.',
                '安装和管理可复用的 Agent 技能。',
              )}
            </p>
            {link('skills', 'Manage skills', '管理技能')}
          </section>
        </>
      )}
      {page === 'assistants' && (
        <section className="panel">
          <h2>{state.settings.agentName || 'Amadeus'}</h2>
          <p>
            {text(
              'Configure this assistant through model connections, skills and memory. OpenAI GPTs are not imported or connected by this page.',
              '通过模型连接、技能和记忆配置当前助手。此页面未导入或连接 OpenAI GPTs。',
            )}
          </p>
          {link('settings', 'Identity and models', '名称与模型')}
          {link('skills', 'Skills', '技能')}
          {link('memory', 'Memory', '记忆')}
        </section>
      )}
      {page === 'security' && (
        <section className="panel">
          <h2>{text('External security services', '外部安全服务')}</h2>
          <p>
            {text(
              'Daybreak is not connected. This app does not include its service, credentials or scan results. An integration requires a supported provider interface and authorization.',
              'Daybreak 尚未接入。本应用不包含该服务、凭证或扫描结果；集成需要服务方支持的接口和授权。',
            )}
          </p>
          <p>
            {text(
              'You can configure a compatible MCP security service, or prepare a local code review. A model review is not a security scan.',
              '可以配置兼容的 MCP 安全服务，或准备本地代码审查。模型审查不等同于安全扫描。',
            )}
          </p>
          {link('plugins', 'Configure integrations', '配置集成')}
          {link('codeReview', 'Prepare code review', '准备代码审查')}
        </section>
      )}
    </section>
  );
}

export const workspaceNavigation = [
  {
    id: 'personal',
    en: 'Personal agent',
    zh: '常驻助手',
    description: 'Ongoing goals and paired devices',
    detail: '长期目标与跨设备连接',
  },
  {
    id: 'spaces',
    en: 'Spaces',
    zh: '工作空间',
    description: 'Projects and their conversations',
    detail: '管理项目与关联会话',
  },
  {
    id: 'background',
    en: 'Scheduled',
    zh: '定时与后台任务',
    description: 'Schedules, ongoing work and results',
    detail: '查看定时计划、运行中的任务与结果',
  },
  {
    id: 'plugins',
    en: 'Plugins',
    zh: '插件',
    description: 'MCP connections and reusable skills',
    detail: '配置 MCP 连接与可复用技能',
  },
  {
    id: 'assistants',
    en: 'Assistants',
    zh: '助手',
    description: 'Model connections, skills and memory',
    detail: '管理模型连接、技能与记忆',
  },
  {
    id: 'codeReview',
    en: 'Code review',
    zh: '代码审查',
    description: 'Prepare a review in a project conversation',
    detail: '在项目会话中准备代码审查',
  },
  {
    id: 'security',
    en: 'Security integrations',
    zh: '安全集成',
    description: 'Capabilities and external service requirements',
    detail: '了解安全服务接入条件与当前能力',
  },
  {
    id: 'siteMap',
    en: 'Site map',
    zh: '功能导航',
    description: 'Find workspace features',
    detail: '查找工作空间功能',
  },
] as const;
export const workspacePages = new Set<string>(
  workspaceNavigation.filter((item) => item.id !== 'background').map((item) => item.id),
);

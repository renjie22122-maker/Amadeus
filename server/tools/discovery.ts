import type { ToolSpec } from '../../shared/types.js';
export const coreTools = new Set([
  'inspect_work_capabilities',
  'schedule_followup',
  'inspect_schedules',
  'pause_scheduled_followup',
  'report_scheduled_result',
  'inspect_tool_plan',
  'set_response_contract',
  'glob',
  'grep',
  'search_tools',
  'inspect_retrieval_status',
  'search_capabilities',
  'interaction_capabilities',
  'batch_read_tools',
  'list_files',
  'read_file',
  'read_attachment',
  'read_json',
  'write_file',
  'register_artifact',
  'create_document',
  'edit_file',
  'apply_patch',
  'inspect_file_version',
  'run_command',
  'background_commands',
  'wait_background_command',
  'ask_user',
  'read_image',
  'media_status',
  'list_media',
  'web_search',
  'fetch_url',
  'read_web_evidence',
  'find_skills',
  'read_skill',
  'search_knowledge',
  'read_spill',
  'inspect_operations',
  'resolve_effect',
  'create_plan',
  'extend_plan',
  'inspect_plan',
  'update_plan',
  'spawn_agent',
  'list_agents',
  'continue_agent',
  'wait_agents',
]);
export function findTools(specs: ToolSpec[], query: string, offset: number, limit: number) {
  const aliases: Record<string, string> = {
    定时: 'schedule followup',
    唤醒: 'schedule followup',
    提醒: 'schedule followup',
    团队: 'team agent discussion',
    辩论: 'team discussion limits challenge',
    通讯: 'message agent team',
    浏览器: 'browser mcp',
    桌面: 'computer mcp',
    截图: 'screenshot image mcp',
    网页: 'web fetch',
    搜索: 'search grep',
    文件: 'file glob',
    下载: 'register_artifact download',
    文档: 'create_document document artifact',
    幻灯片: 'create_document pptx',
    PPT: 'create_document pptx',
    Excel: 'create_document xlsx',
    技能: 'skill',
    记忆: 'memory',
    知识库: 'knowledge',
    假说: 'research hypothesis',
    长程阅读: 'knowledge context',
    取证: 'research evidence',
    工作流: 'workflow',
    批量: 'batch',
    终端: 'command bash',
    图片: 'image',
    视频: 'video media',
    音频: 'audio media transcribe',
    计算: 'python transform',
    表格: 'document python',
    转录: 'transcribe',
    抽帧: 'extract media frames',
    音乐: 'audio music media',
    展示: 'import media',
  };
  const expanded =
    query +
    ' ' +
    Object.entries(aliases)
      .filter(([k]) => query.includes(k))
      .map(([, v]) => v)
      .join(' ');
  const terms = expanded
    .toLowerCase()
    .split(/[\s_\-]+/)
    .filter(Boolean);
  const ranked = specs
    .map((tool) => {
      const name = tool.name.toLowerCase(),
        hay = (name + ' ' + tool.description + ' ' + tool.effect).toLowerCase();
      return {
        tool,
        score: terms.reduce(
          (n, t) => n + (name === t ? 20 : name.includes(t) ? 5 : hay.includes(t) ? 1 : 0),
          0,
        ),
      };
    })
    .filter((x) => !terms.length || x.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return { total: ranked.length, results: ranked.slice(offset, offset + limit).map((x) => x.tool) };
}

// Discover a workflow's adjacent tools together; availability is still filtered by specs().
const toolFamilies = [
  [
    'run_python',
    'extract_media_audio',
    'extract_media_frames',
    'read_image',
    'background_commands',
    'wait_background_command',
  ],
  ['read_document', 'read_attachment'],
  [
    'read_skill',
    'list_skill_files',
    'read_skill_file',
    'inspect_skill_readiness',
    'materialize_skill_file',
    'prepare_skill_environment',
  ],
  [
    'create_research_case',
    'inspect_research_case',
    'update_research_case',
    'investigate_research_gap',
    'read_knowledge_context',
    'read_knowledge_document',
  ],
  [
    'media_services',
    'generate_media',
    'media_status',
    'list_media',
    'import_media',
    'inspect_media',
    'export_media',
    'transcribe_media',
    'extract_media_audio',
    'extract_media_frames',
    'cancel_media',
  ],
];
export function relatedToolNames(names: string[]) {
  const selected = new Set(names);
  for (const family of toolFamilies)
    if (family.some((name) => selected.has(name))) for (const name of family) selected.add(name);
  return [...selected];
}

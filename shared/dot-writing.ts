export const writingTools = {
  写作评估: {
    field: '评估重点',
    choices: ['清晰度与结构', '论证与证据', '简洁度'],
    action: '评估原文',
    result: '评估与修改依据',
    edit: false,
    instruction:
      'Evaluate the requested dimension. Cite specific passages and give actionable feedback.',
  },
  读者反馈: {
    field: '目标读者',
    choices: ['普通读者', '同事', '主管', '客户', '技术专家'],
    action: '模拟读者反馈',
    result: '读者可能记住什么、追问什么',
    edit: false,
    instruction:
      'From the selected reader perspective, present likely takeaways, questions and points of confusion. Label inferences.',
  },
  改写: {
    field: '写作风格',
    choices: ['简洁', '专业', '学术', '亲切', '创意'],
    action: '生成改写',
    result: '改写候选',
    edit: true,
    instruction: 'Rewrite in the chosen style. Return only the revised text.',
  },
  自然表达: {
    field: '表达方式',
    choices: ['日常对话', '工作沟通', '保留作者口吻'],
    action: '调整表达',
    result: '表达候选',
    edit: true,
    instruction:
      'Make the phrasing idiomatic for the chosen setting. Preserve facts and voice. Return only revised text.',
  },
  来源核对: {
    field: '参考资料',
    choices: [],
    action: '比对原文与资料',
    result: '有依据与待核实的说法',
    edit: false,
    instruction:
      'Compare the text only against the provided references. Quote supporting or conflicting excerpts. Identify unsupported claims. Do not infer a plagiarism score.',
  },
  简历优化: {
    field: '目标职位或岗位描述',
    choices: [],
    action: '优化简历片段',
    result: '简历候选',
    edit: true,
    instruction:
      'Adapt the resume to the role using only supplied experience and metrics. Do not invent credentials or quantify unreported outcomes. Return only revised text.',
  },
  摘要: {
    field: '摘要格式',
    choices: ['一句话', '要点列表', '执行摘要'],
    action: '生成摘要',
    result: '摘要',
    edit: true,
    instruction: 'Summarize using the selected format. Return only the summary.',
  },
  润色: {
    field: '修改力度',
    choices: ['仅修正语法', '改善流畅度', '压缩冗余'],
    action: '润色原文',
    result: '润色候选',
    edit: true,
    instruction:
      'Polish according to the selected editing level, preserving meaning. Return only revised text.',
  },
  语气: {
    field: '交流场景',
    choices: ['工作邮件', '朋友聊天', '公开发言'],
    action: '分析语气',
    result: '语气与措辞依据',
    edit: false,
    instruction: 'Describe the tone in context. Cite wording and suggest concrete alternatives.',
  },
  翻译: {
    field: '目标语言',
    choices: ['简体中文', '英语', '日语', '法语', '德语', '西班牙语'],
    action: '翻译原文',
    result: '译文',
    edit: true,
    instruction: 'Translate into the specified target language. Return only the translation.',
  },
  解释: {
    field: '读者基础',
    choices: ['第一次接触', '有一定基础', '专业读者'],
    action: '解释这段内容',
    result: '解释',
    edit: false,
    instruction:
      'Explain the passage at the selected level, using a concrete example where helpful.',
  },
};
export type WritingMode = keyof typeof writingTools;

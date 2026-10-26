export const toneGroups = [
  {
    name: ['互动气质', 'Social tone'],
    axes: [
      ['warmth', '温暖', 'Warmth'],
      ['humor', '幽默', 'Humor'],
      ['empathy', '共情', 'Empathy'],
      ['playfulness', '俏皮', 'Playfulness'],
      ['roleplay', '角色感', 'Roleplay'],
      ['expression', '表情使用', 'Expression'],
    ],
  },
  {
    name: ['观点与表达', 'Views and expression'],
    axes: [
      ['stance', '立场鲜明', 'Opinionated'],
      ['directness', '表达直接', 'Directness'],
      ['caveats', '额外提醒', 'Caveats'],
      ['nuance', '多面分析', 'Nuance'],
      ['explanation', '解释细致', 'Detail'],
      ['imagination', '联想创意', 'Creativity'],
    ],
  },
  {
    name: ['聊天节奏', 'Conversation rhythm'],
    axes: [
      ['brevity', '简洁', 'Brevity'],
      ['initiative', '主动接话', 'Engagement'],
      ['curiosity', '追问兴趣', 'Curiosity'],
      ['spontaneity', '随性', 'Spontaneity'],
      ['slang', '口语化', 'Colloquial'],
      ['energy', '活泼', 'Energy'],
    ],
  },
] as const;
export type ToneKey = (typeof toneGroups)[number]['axes'][number][0];
export type ChatTone = Record<ToneKey, number>;
export const defaultTone = Object.fromEntries(
  toneGroups.flatMap((g) => g.axes.map(([key]) => [key, 50])),
) as ChatTone;
export const tonePresets: { name: [string, string]; values: Partial<ChatTone> }[] = [
  {
    name: ['自然群友', 'Casual peer'],
    values: {
      warmth: 65,
      humor: 70,
      playfulness: 70,
      brevity: 75,
      caveats: 15,
      stance: 65,
      slang: 80,
      spontaneity: 75,
      explanation: 30,
    },
  },
  {
    name: ['温暖陪伴', 'Warm companion'],
    values: { warmth: 90, empathy: 90, directness: 35, curiosity: 65, energy: 45, caveats: 25 },
  },
  {
    name: ['干脆直率', 'Candid and concise'],
    values: { directness: 90, stance: 85, brevity: 90, caveats: 10, explanation: 25, nuance: 35 },
  },
  {
    name: ['冷幽默', 'Dry wit'],
    values: {
      humor: 85,
      playfulness: 70,
      energy: 25,
      expression: 20,
      brevity: 80,
      caveats: 15,
      stance: 65,
    },
  },
  {
    name: ['细致讨论', 'Thoughtful discussion'],
    values: {
      nuance: 85,
      explanation: 85,
      curiosity: 75,
      brevity: 25,
      directness: 65,
      caveats: 55,
    },
  },
];
export const mbtiStyles = [
  'ISTJ',
  'ISFJ',
  'INFJ',
  'INTJ',
  'ISTP',
  'ISFP',
  'INFP',
  'INTP',
  'ESTP',
  'ESFP',
  'ENFP',
  'ENTP',
  'ESTJ',
  'ESFJ',
  'ENFJ',
  'ENTJ',
] as const;

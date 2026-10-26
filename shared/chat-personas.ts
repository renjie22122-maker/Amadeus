import { defaultTone, type ChatTone } from './chat-tone.js';
export interface StyleReference {
  name: string;
  description: string;
  strength: number;
}
export const styleReferences: {
  id: string;
  name: string;
  category: string;
  description: string;
  tone: Partial<ChatTone>;
}[] = [
  {
    id: 'oc-1',
    name: '电波女',
    category: 'OC性格',
    description: '联想跳跃，带独特比喻和自成一格的思路。',
    tone: {
      imagination: 95,
      spontaneity: 85,
      roleplay: 75,
    },
  },
  {
    id: 'oc-2',
    name: '病娇',
    category: 'OC性格',
    description: '虚构角色中浓烈、敏感而执着的情绪张力，不将角色设定当作真实关系。',
    tone: {
      roleplay: 85,
      energy: 70,
      empathy: 65,
    },
  },
  {
    id: 'oc-3',
    name: '黑化',
    category: 'OC性格',
    description: '角色状态由柔和转为冷峻的戏剧反差；可指定适用情节。',
    tone: {
      roleplay: 85,
      warmth: 25,
      directness: 80,
    },
  },
  {
    id: 'oc-4',
    name: '腹黑',
    category: 'OC性格',
    description: '温和外表下藏机智、反讽和轻巧试探。',
    tone: {
      humor: 75,
      playfulness: 80,
      directness: 30,
    },
  },
  {
    id: 'oc-5',
    name: '傲娇',
    category: 'OC性格',
    description: '表达强硬、关心含蓄，嘴硬与心软形成反差。',
    tone: {
      directness: 80,
      warmth: 35,
      empathy: 80,
      playfulness: 75,
      roleplay: 80,
    },
  },
  {
    id: 'oc-6',
    name: '傲沉',
    category: 'OC性格',
    description: '强硬表达后会别扭地收敛、反思，留出情绪变化。',
    tone: {
      directness: 65,
      energy: 30,
      roleplay: 75,
    },
  },
  {
    id: 'oc-7',
    name: '别扭',
    category: 'OC性格',
    description: '关心明显但不善于直说，含蓄、害羞，偶尔转移话题。',
    tone: {
      warmth: 65,
      directness: 25,
      roleplay: 65,
    },
  },
  {
    id: 'oc-8',
    name: '中二病',
    category: 'OC性格',
    description: '使用夸张称号、幻想比喻和戏剧化措辞。',
    tone: {
      imagination: 95,
      roleplay: 95,
      energy: 80,
    },
  },
  {
    id: 'oc-9',
    name: '痴女/变态',
    category: 'OC性格',
    description: '成人虚构情境中的大胆、暧昧风格；不包含骚扰或侵犯行为。',
    tone: {
      roleplay: 80,
      playfulness: 85,
      directness: 80,
    },
  },
  {
    id: 'oc-10',
    name: '圣母',
    category: 'OC性格',
    description: '理想主义、宽容和关怀的创作取向。',
    tone: {
      warmth: 95,
      empathy: 95,
      directness: 30,
    },
  },
  {
    id: 'oc-11',
    name: '人妻',
    category: 'OC性格',
    description: '居家、体贴、可靠的照顾型表达，不主张真实婚姻身份。',
    tone: {
      warmth: 90,
      empathy: 85,
      energy: 40,
    },
  },
  {
    id: 'oc-12',
    name: '吃货',
    category: 'OC性格',
    description: '喜欢围绕食物、美味和饮食体验作轻松联想。',
    tone: {
      imagination: 70,
      humor: 65,
      energy: 65,
    },
  },
  {
    id: 'oc-13',
    name: '无存（阿卡林）',
    category: 'OC性格',
    description: '存在感低调、少抢话，以偶尔的简短反应参与。',
    tone: {
      initiative: 15,
      brevity: 90,
      expression: 20,
    },
  },
  {
    id: 'oc-14',
    name: '弱气',
    category: 'OC性格',
    description: '柔和腼腆、声势不强，但可有坚定的内在立场。',
    tone: {
      warmth: 80,
      directness: 25,
      energy: 25,
    },
  },
  {
    id: 'oc-15',
    name: '阴气',
    category: 'OC性格',
    description: '安静、幽幽的氛围与不显眼的温柔。',
    tone: {
      energy: 15,
      initiative: 20,
      expression: 15,
      roleplay: 70,
    },
  },
  {
    id: 'oc-16',
    name: '丧女',
    category: 'OC性格',
    description: '社交笨拙与丰富内心吐槽并存的虚构表现。',
    tone: {
      humor: 65,
      initiative: 20,
      imagination: 75,
      roleplay: 70,
    },
  },
  {
    id: 'oc-17',
    name: '大和抚子',
    category: 'OC性格',
    description: '礼貌、温婉、体贴，表达克制而有自己的原则。',
    tone: {
      warmth: 85,
      empathy: 85,
      slang: 20,
      energy: 35,
    },
  },
  {
    id: 'oc-18',
    name: '毒舌',
    category: 'OC性格',
    description: '短促、犀利、机智的吐槽；重点在观点与笑点。',
    tone: {
      directness: 90,
      humor: 85,
      brevity: 90,
      stance: 85,
    },
  },
  {
    id: 'oc-19',
    name: '天然呆',
    category: 'OC性格',
    description: '带天真、意外联想和轻微慢半拍的喜剧表达。',
    tone: {
      playfulness: 80,
      imagination: 75,
      warmth: 80,
      roleplay: 70,
    },
  },
  {
    id: 'oc-20',
    name: '三无',
    category: 'OC性格',
    description: '寡言、平静、少表情，情绪更多留在简短措辞中。',
    tone: {
      brevity: 95,
      expression: 5,
      energy: 10,
      initiative: 20,
    },
  },
  {
    id: 'oc-21',
    name: '女王',
    category: 'OC性格',
    description: '自信、有主见、从容且带气势的表达。',
    tone: {
      stance: 90,
      directness: 85,
      initiative: 75,
      roleplay: 80,
    },
  },
  {
    id: 'oc-22',
    name: '小恶魔',
    category: 'OC性格',
    description: '俏皮、机灵、爱轻度捉弄，带善意反差。',
    tone: {
      playfulness: 95,
      humor: 85,
      warmth: 65,
    },
  },
  {
    id: 'oc-23',
    name: '软妹',
    category: 'OC性格',
    description: '柔软、温和、亲切且体贴的表达。',
    tone: {
      warmth: 95,
      empathy: 85,
      directness: 25,
    },
  },
  {
    id: 'oc-24',
    name: '荡漾',
    category: 'OC性格',
    description: '洒脱、自信、灵巧而带魅力的角色气质。',
    tone: {
      spontaneity: 85,
      playfulness: 80,
      stance: 75,
    },
  },
  {
    id: 'oc-25',
    name: '元气',
    category: 'OC性格',
    description: '明快、积极、有活力，但不靠不断刷屏体现。',
    tone: {
      energy: 95,
      warmth: 80,
      initiative: 75,
      expression: 80,
    },
  },
  {
    id: 'oc-26',
    name: '无铁炮',
    category: 'OC性格',
    description: '比元气更奔放、直来直往的喜剧气质；不故意做错实际任务。',
    tone: {
      energy: 100,
      spontaneity: 95,
      directness: 85,
      roleplay: 80,
    },
  },
  {
    id: 'oc-27',
    name: '冒失女',
    category: 'OC性格',
    description: '通过措辞和小小自嘲表现笨拙感，不制造实际操作失误。',
    tone: {
      playfulness: 80,
      spontaneity: 75,
      roleplay: 75,
    },
  },
  {
    id: 'oc-28',
    name: '天然无',
    category: 'OC性格',
    description: '安静简短，偶有天真的跳跃联想和温柔反差。',
    tone: {
      brevity: 90,
      energy: 15,
      expression: 10,
      imagination: 75,
    },
  },
  {
    id: 'oc-29',
    name: '食草',
    category: 'OC性格',
    description: '温和、含蓄、慢热，重视舒适的交流距离。',
    tone: {
      warmth: 80,
      initiative: 20,
      directness: 30,
    },
  },
  {
    id: 'oc-30',
    name: '食肉',
    category: 'OC性格',
    description: '坦率、主动、自信，表达兴趣直接而尊重回应。',
    tone: {
      initiative: 85,
      directness: 85,
      energy: 80,
    },
  },
  {
    id: 'oc-31',
    name: '高冷',
    category: 'OC性格',
    description: '克制、冷静、简洁，保持距离感而不故意失礼。',
    tone: {
      warmth: 25,
      brevity: 85,
      energy: 20,
      expression: 10,
    },
  },
  {
    id: 'ref-1',
    name: '口癖',
    category: '语言动作',
    description: '可指定惯用词或语尾，并允许随场景自然省略。',
    tone: {},
  },
  {
    id: 'ref-2',
    name: '吐槽',
    category: '语言动作',
    description: '以机智评论回应情境。',
    tone: {},
  },
  {
    id: 'ref-3',
    name: '无口',
    category: '语言动作',
    description: '以少量简短话语表达。',
    tone: {},
  },
  {
    id: 'ref-4',
    name: '颜艺',
    category: '语言动作',
    description: '用文字反应或合适表情传达丰富表情感。',
    tone: {},
  },
  {
    id: 'ref-5',
    name: '甜食控',
    category: '嗜好习惯',
    description: '以甜点爱好作可选话题偏好。',
    tone: {},
  },
  {
    id: 'ref-6',
    name: '书虫',
    category: '嗜好习惯',
    description: '喜欢阅读与知识联想的虚构偏好。',
    tone: {},
  },
  {
    id: 'ref-7',
    name: '慵懒',
    category: '嗜好习惯',
    description: '偏慢节奏、少折腾的表达方式。',
    tone: {},
  },
  {
    id: 'ref-8',
    name: '侦探',
    category: '虚构身份',
    description: '观察细节、提出线索式问题的角色框架。',
    tone: {},
  },
  {
    id: 'ref-9',
    name: '冒险者',
    category: '虚构身份',
    description: '探索与旅途感的角色框架。',
    tone: {},
  },
  {
    id: 'ref-10',
    name: '精灵',
    category: '虚构身份',
    description: '可自行补充世界观的幻想角色框架。',
    tone: {},
  },
  {
    id: 'ref-11',
    name: '银发',
    category: '外观设定',
    description: '仅用于角色形象描述，不决定性格。',
    tone: {},
  },
  {
    id: 'ref-12',
    name: '眼镜',
    category: '外观设定',
    description: '仅用于角色形象描述，不决定能力或性格。',
    tone: {},
  },
  {
    id: 'ref-13',
    name: '猫耳',
    category: '外观设定',
    description: '仅用于虚构形象描述，不暗示现实身体。',
    tone: {},
  },
  {
    id: 'ref-14',
    name: '同伴',
    category: '关系框架',
    description: '合作、平等的虚构互动关系。',
    tone: {},
  },
  {
    id: 'ref-15',
    name: '宿敌',
    category: '关系框架',
    description: '轻松竞争、相互较劲的虚构互动关系。',
    tone: {},
  },
];
// Editorial starting points, not measured personality scores. No name-based runtime branches.
export function blendStyleReferences(selected: StyleReference[]): ChatTone {
  const result = { ...defaultTone };
  for (const key of Object.keys(result) as (keyof ChatTone)[]) {
    let total = 0,
      weights = 0;
    for (const item of selected) {
      const reference = styleReferences.find(
        (r) => r.name === item.name && r.description === item.description,
      );
      const value = reference?.tone[key];
      if (value === undefined) continue;
      const weight = Math.max(0, Math.min(100, item.strength)) / 100;
      total += (value - 50) * weight;
      weights += weight;
    }
    result[key] = Math.round(50 + total / Math.max(1, weights));
  }
  return result;
}

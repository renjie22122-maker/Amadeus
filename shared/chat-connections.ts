export const chatPlatforms = [
  {
    id: 'telegram',
    name: 'Telegram',
    transport: 'telegram',
    official: true,
    url: 'https://core.telegram.org/bots/api',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp Business',
    transport: 'whatsapp',
    official: true,
    url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/',
  },
  {
    id: 'vk',
    name: 'VK community bot',
    transport: 'vk',
    official: true,
    url: 'https://github.com/VKCOM/vk-api-schema',
  },
  {
    id: 'qq-official',
    name: 'QQ official bot',
    transport: 'qq',
    official: true,
    url: 'https://github.com/tencent-connect/qqbot-nodejs',
  },
  {
    id: 'wecom',
    name: 'WeCom / 企业微信',
    transport: 'wecom',
    official: true,
    url: 'https://github.com/WecomTeam/aibot-node-sdk',
  },
  {
    id: 'qq',
    name: 'QQ · OneBot 11',
    transport: 'onebot11',
    official: false,
    url: 'https://github.com/NapNeko/NapCatQQ',
  },
  {
    id: 'wechat',
    name: 'WeChat · OneBot 12',
    transport: 'onebot12',
    official: false,
    url: 'https://github.com/JustUndertaker/ComWeChatBotClient',
  },
] as const;
export type ChatTransport = (typeof chatPlatforms)[number]['transport'];
export interface ChatConnection {
  id: string;
  name: string;
  transport: ChatTransport;
  conversationId: string;
  senderId: string;
  peerId: string;
  enabled: boolean;
  endpoint: string;
  accountId: string;
  apiVersion: string;
  webhookPort: number;
  remoteApprovals: boolean;
  peerType?: 'private' | 'group';
  accessMode?: 'chat' | 'work';
  allowedSenders?: string[];
  allGroupMembers?: boolean;
  groupPrefix?: string;
  sharedKnowledge?: boolean;
  groupContext?: boolean;
  groupReplyMode?: 'mentions' | 'participate';
  autoInviteGroups?: boolean;
  reviewFriendRequests?: boolean;
  authorizedTarget: string;
  activatedAt: number;
  revision: number;
}
export interface ChatIncoming {
  id: string;
  senderId: string;
  peerId: string;
  text: string;
  timestamp: number;
  peerType?: 'private' | 'group';
  media?: ChatRemoteFile[];
  addressed?: boolean;
}
export interface ChatSecrets {
  token: string;
  appSecret: string;
  verifyToken: string;
}

export interface ChatRemoteFile {
  id?: string;
  url?: string;
  name: string;
  kind: 'image' | 'audio' | 'video' | 'file';
  aeskey?: string;
  sha256?: string;
}

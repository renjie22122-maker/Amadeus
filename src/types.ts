import type {
  AgentEvent,
  Attachment,
  Conversation,
  Memory,
  PendingInput,
  Project,
  PublicProfile,
  Run,
  Settings,
  Skill,
} from '../shared/types';
export type RunView = Omit<Run, 'checkpoints'>;
export interface UiState {
  conversations: Conversation[];
  projects: Project[];
  runs: RunView[];
  skills: Omit<Skill, 'source' | 'content'>[];
  memories: Memory[];
  documents: {
    id: string;
    name: string;
    scope: string;
    characters: number;
    createdAt: number;
    hash: string;
  }[];
  settings: Omit<Settings, 'profiles' | 'embedding'> & {
    profiles: PublicProfile[];
    embedding: Omit<Settings['embedding'], 'apiKey'> & { hasKey: boolean };
  };
}
export interface ConversationDetail {
  hasOlderEvents?: boolean;
  teamAutomation?: any;
  teamRecovery?: any[];
  teamControlEvents?: any[];
  teamSpace?: {
    id: string;
    mode: 'host' | 'creative';
    status: string;
    revision: number;
    maxMessages: number;
    autoEnroll?: boolean;
    selection?: { by: 'agent' | 'user'; reason: string };
    discussionBudget?: { limit: number; used: number; remaining: number; unit: string };
    roles: Record<string, string>;
    blockers: string[];
    closed: Record<string, string>;
    messages: { id: string; sender: string; recipients?: string[]; text: string; at?: number }[];
  } | null;
  teamScheduling?: {
    enabled: boolean;
    workers: string[];
    maxLoad: number;
    blocked?: { taskId: string; reason: string }[];
    loads?: { runId: string; load: number }[];
  } | null;
  teamMembers?: {
    runId: string;
    name?: string;
    status: string;
    role: string;
    depth: number;
    tasks: string[];
    unresolvedEffects: number;
  }[];
  taskBoard?: {
    revision: number;
    tasks: {
      id: string;
      title: string;
      acceptance: string;
      weight?: number;
      status: string;
      owner: string | null;
      dependsOn: string[];
      evidence: number[];
      note: string;
      verification?: { status: string; eventId: number; checkedBy: string };
    }[];
  } | null;
  conversation: Conversation;
  events: AgentEvent[];
  inputs: PendingInput[];
  attachments: Omit<Attachment, 'path' | 'text'>[];
  unknownEffects: {
    id: string;
    run_id: string;
    tool: string;
    args: string;
    state: string;
    result: string | null;
  }[];
  streams: { runId: string; conversationId: string; messageId: string; text: string }[];
}
export type Action = (fn: () => Promise<unknown>) => Promise<unknown>;

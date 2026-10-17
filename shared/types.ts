import type { MediaConnection } from './media.js';
export type Reasoning = 'auto' | 'none' | 'low' | 'medium' | 'high' | 'max';
export type PermissionMode = 'read-only' | 'ask' | 'auto' | 'trusted';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'waiting_approval'
  | 'waiting_children'
  | 'completed'
  | 'failed'
  | 'interrupted';
export type Transport = 'openai-chat' | 'anthropic' | 'openai-responses' | 'gemini';
export interface Usage {
  input: number;
  output: number;
  cached: number;
  reasoning?: number;
  measured: boolean;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface ModelMessage {
  sourceWarnings?: string[];
  contextKind?:
    | 'runtime-snapshot'
    | 'runtime-advice'
    | 'task-snapshot'
    | 'source-ledger'
    | 'history-handoff'
    | 'trust-ledger';
  contextSourceCallId?: string;
  contextPatch?: string;
  contextResultHash?: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  calls?: ToolCall[];
  callId?: string;
  reasoning?: string;
  native?: unknown[];
  images?: string[];
}
export interface Profile {
  id: string;
  name: string;
  transport: Transport;
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoning: Reasoning;
  reasoningFormat: 'none' | 'openai' | 'deepseek' | 'anthropic' | 'gemini';
  efforts: Reasoning[];
  contextWindow: number;
  maxOutputTokens: number;
  timeoutMs: number;
  vision: boolean;
  prices: { input: number | null; output: number | null; cached: number | null };
}
export type PublicProfile = Omit<Profile, 'apiKey'> & { hasKey: boolean };
export interface ToolHook {
  id: string;
  enabled: boolean;
  stage:
    | 'beforeTool'
    | 'afterTool'
    | 'beforeCommand'
    | 'afterCommand'
    | 'beforeCompaction'
    | 'afterCompaction'
    | 'beforeTaskComplete'
    | 'afterTaskComplete'
    | 'beforeMemoryWrite'
    | 'afterMemoryWrite';
  tool: string;
  action: 'deny' | 'notify' | 'command';
  command?: string;
  timeoutSeconds?: number;
  message: string;
  projectId?: string;
}
export interface AgentSpecialist {
  id: string;
  name: string;
  instructions: string;
  skillIds: string[];
  allowedTools: string[];
}
export interface ActionRule {
  id: string;
  enabled: boolean;
  tool: string;
  decision: 'deny' | 'ask';
  projectId?: string;
  pathGlob?: string;
  commandEquals?: string;
  backend?: string;
  reason: string;
}
export interface Settings {
  specialists?: AgentSpecialist[];
  actionRules?: ActionRule[];
  hooks?: ToolHook[];

  agentName?: string;
  autoReview?: { profileId: string; timeoutMs: number };
  media?: {
    connections: MediaConnection[];
    transcriptionId: string;
    autoApproveMaxUsd: number | null;
  };
  web?: {
    enabled: boolean;
    searchProfileId: string;
    searchBaseUrl: string;
    searchModel: string;
    timeoutMs: number;
  };
  profiles: Profile[];
  defaultProfileId: string;
  maxParallelRuns: number;
  maxAgentDepth: number;
  maxChildren: number;
  compactionRatio: number;
  dockerImage: string;
  dockerUser?: string;
  approveFileWrites?: boolean;
  commandBackend: 'approval-host' | 'docker' | 'native-windows';
  nativePython?: string;
  nativeNetwork?: 'deny' | 'host';
  retrieval?: import('./retrieval.js').RetrievalSettings;
  embedding: { baseUrl: string; apiKey: string; model: string; backend?: 'remote' | 'local' };
  mcp: {
    id: string;
    name: string;
    command: string;
    args: string[];
    enabled: boolean;
    capability?: 'general' | 'browser' | 'computer';
    builtin?: 'browser' | 'computer';
    browser?: { allowedHosts: string[]; persistSession: boolean };
  }[];
}
export interface Project {
  removedAt?: number | null;
  id: string;
  name: string;
  folders: string[];
  createdAt: number;
}
export interface SubagentModels {
  defaultProfileId: string | null;
  allowedProfileIds: string[];
}
export interface Conversation {
  subagentModels?: SubagentModels | null;
  titleGeneration?: { runId: string; state: 'pending' | 'attempted' | 'done' | 'manual' };
  allowedTools?: string[];
  specialistId?: string;
  execution?: { backend: Settings['commandBackend']; network: 'host' | 'deny' } | null;
  isolationId?: string;
  teamMode?: 'auto' | 'hierarchy' | 'host' | 'creative';
  teamStrategy?: 'off' | 'auto' | 'prefer';
  id: string;
  title: string;
  projectId: string | null;
  profileId: string;
  reasoning: Reasoning;
  permission: PermissionMode;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  parentId: string | null;
  forkEvent: number | null;
  skillIds: string[];
  knowledge: boolean;
  memory: boolean;
  includeUserMemory?: boolean;
  generateMemory?: boolean;
  automaticMemory?: boolean;
  memoryPolicy?: 'inherit' | 'override';
  memoryGenerationTarget?: string;
}
export interface ContextSample {
  fingerprint: string;
  digest: string;
  units: number;
  tokens: number;
  messageCount: number;
  toolsDigest: string;
}
export interface Run {
  termination?: {
    code: string;
    category: 'limit' | 'stagnation' | 'cancelled' | 'protocol' | 'execution';
    recoverable: boolean;
  };
  recoveredFrom?: string;
  controlTicket?: string;
  recoveryOnly?: boolean;
  executionBlock?: { signature: string; reason: string };
  contextSample?: ContextSample;
  lastContextInputTokens?: number;
  lastContextMeasuredAt?: number;
  id: string;
  conversationId: string;
  status: RunStatus;
  parentRunId: string | null;
  depth: number;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  checkpoints: ModelMessage[];
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  modelCalls: number;
  estimatedUsd: number | null;
  maxSteps: number;
  profileId: string;
  reasoning: Reasoning;
  providerFingerprint?: string;
  usageComplete?: boolean;
}
export interface AgentEvent {
  id: number;
  conversationId: string;
  runId: string | null;
  type: string;
  data: Record<string, any>;
  createdAt: number;
}
export interface PendingInput {
  id: string;
  runId: string;
  conversationId: string;
  kind: 'approval' | 'question';
  payload: Record<string, any>;
  status: 'pending' | 'answered' | 'denied' | 'cancelled';
  answer: string | null;
  createdAt: number;
}
export interface Attachment {
  sha256?: string;
  messageEventId?: number;
  id: string;
  conversationId: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  text: string;
  createdAt: number;
}
export interface Skill {
  manifest?: { requires: string[]; tools: string[]; verification: string[]; hasHooks: boolean };
  categories?: Array<{ id: string; labelEn: string; labelZh: string }>;
  sourceGroup?: string;
  id: string;
  name: string;
  description: string;
  content: string;
  source: string;
  enabled: boolean;
  createdAt: number;
}
export interface Memory {
  candidateReview?: { status: 'enabled' | 'needs_review' | 'blocked'; reason: string; at: number };
  decayPolicy?: 'auto' | 'stable' | 'time' | 'turns' | 'time-and-turns';
  halfLifeDays?: number;
  halfLifeTurns?: number;
  recallScope?: 'auto' | 'conversation' | 'scope';
  topic?: string;
  automatic?: boolean;
  kind?: 'preference' | 'decision' | 'episode' | 'experience';
  status?: 'candidate' | 'inactive' | 'active' | 'superseded' | 'disputed' | 'forgotten';
  recordedAt?: number;
  validFrom?: number;
  validUntil?: number | null;
  supersedes?: string[];
  sourceRefs?: string[];
  duplicateOf?: string;
  conflictsWith?: string[];
  entityId?: string;
  attribute?: string;
  factCardinality?: 'single' | 'multiple';
  value?: string;
  conditions?: string;
  evidence?: { conversationId: string; eventId: number; quote?: string }[];
  sourceConversationId?: string;
  sourceEventId?: number;
  id: string;
  scope: string;
  content: string;
  source: string;
  active: boolean;
  expiresAt: number | null;
  revision: number;
  createdAt: number;
}
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, any>;
  effect: 'read' | 'write' | 'execute' | 'network' | 'coordinate';
}
export interface ToolOutcome {
  status: 'succeeded' | 'denied' | 'not_started' | 'failed' | 'unknown';
  code: string;
  executionStarted?: boolean;
  effectId?: string;
}
export interface ToolResult {
  outcome?: ToolOutcome;
  images?: string[];
  content: string;
  metadata?: Record<string, any>;
}

export type MediaKind = 'image' | 'video' | 'music' | 'speech' | 'transcription' | 'model3d';
export type MediaProtocol =
  | 'minimax-image'
  | 'minimax-video'
  | 'minimax-speech'
  | 'minimax-transcription'
  | 'minimax-music'
  | 'openai-image'
  | 'openai-video'
  | 'openai-transcription'
  | 'openai-speech'
  | 'fal'
  | 'replicate'
  | 'gemini-image'
  | 'gemini-video'
  | 'gemini-music'
  | 'eleven-music'
  | 'eleven-speech'
  | 'deepgram'
  | 'assemblyai'
  | 'meshy'
  | 'tripo';
export interface MediaConnection {
  id: string;
  name: string;
  protocol: MediaProtocol;
  kind: MediaKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  defaults: Record<string, unknown>;
  estimatedUsd: number | null;
  capabilities?: {
    readAloud?: { protocol: 'wav-ndjson-v1'; target: string };
    references?: {
      target: string;
      maxPerField?: number;
      maxTotal?: number;
      arrayFields?: string[];
    };
  };
}
export interface MediaJob {
  id: string;
  conversationId: string;
  runId?: string;
  operationKey: string;
  purpose?: 'read-aloud' | 'generation';
  connectionId: string;
  protocol: MediaProtocol;
  kind: MediaKind;
  model: string;
  origin: string;
  baseUrl: string;
  prompt: string;
  status: 'submitting' | 'queued' | 'running' | 'completed' | 'failed' | 'unknown' | 'cancelled';
  remoteId?: string;
  statusUrl?: string;
  resultUrl?: string;
  cancelUrl?: string;
  createdAt: number;
  updatedAt: number;
  nextPollAt?: number;
  error?: string;
  text?: string;
  estimatedUsd: number | null;
  actualUsd: number | null;
  outputs: {
    id: string;
    mime: string;
    name: string;
    preview?: boolean;
    inspection?: { audio: string; method: string; audioTracks?: number; videoTracks?: number };
  }[];
}
export const mediaProtocols: {
  id: MediaProtocol;
  name: string;
  kind: MediaKind;
  baseUrl: string;
  model: string;
  docs: string;
}[] = [
  {
    id: 'minimax-image',
    name: 'MiniMax official \u00b7 Images',
    kind: 'image',
    baseUrl: 'https://api.minimax.io',
    model: 'image-01',
    docs: 'https://platform.minimax.io/docs/api-reference/image-generation-t2i',
  },
  {
    id: 'minimax-video',
    name: 'MiniMax official \u00b7 Hailuo / H3 Video',
    kind: 'video',
    baseUrl: 'https://api.minimax.io',
    model: 'MiniMax-Hailuo-2.3',
    docs: 'https://platform.minimax.io/docs/api-reference/video-generation-v2-create',
  },
  {
    id: 'minimax-speech',
    name: 'MiniMax official \u00b7 Speech',
    kind: 'speech',
    baseUrl: 'https://api.minimax.io',
    model: 'speech-2.8-hd',
    docs: 'https://platform.minimax.io/docs/api-reference/speech-t2a-http',
  },
  {
    id: 'minimax-transcription',
    name: 'MiniMax official \u00b7 Transcription',
    kind: 'transcription',
    baseUrl: 'https://api.minimax.io',
    model: 'asr-1.0',
    docs: 'https://platform.minimax.io/docs/api-reference/speech-to-text',
  },
  {
    id: 'minimax-music',
    name: 'MiniMax official \u00b7 Music (account access required)',
    kind: 'music',
    baseUrl: 'https://api.minimax.io',
    model: 'music-3.0',
    docs: 'https://platform.minimax.io/docs/api-reference/music-generation',
  },
  {
    id: 'meshy',
    name: 'Meshy · Text / Image / Multi-image to 3D',
    kind: 'model3d',
    baseUrl: 'https://api.meshy.ai',
    model: 'meshy-7.1',
    docs: 'https://docs.meshy.ai/en/api/text-to-3d',
  },
  {
    id: 'tripo',
    name: 'Tripo · Text / Image / Multi-view to 3D',
    kind: 'model3d',
    baseUrl: 'https://openapi.tripo3d.ai/v3',
    model: '',
    docs: 'https://developers.tripo3d.ai/en/docs/migration-v2-to-v3',
  },
  {
    id: 'openai-image',
    name: 'OpenAI / compatible · Images',
    kind: 'image',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    docs: 'https://platform.openai.com/docs/guides/image-generation',
  },
  {
    id: 'fal',
    name: 'fal.ai · Image / Video / Music',
    kind: 'image',
    baseUrl: 'https://queue.fal.run',
    model: 'fal-ai/flux/schnell',
    docs: 'https://fal.ai/models',
  },
  {
    id: 'replicate',
    name: 'Replicate · Image / Video / Music',
    kind: 'image',
    baseUrl: 'https://api.replicate.com/v1',
    model: 'black-forest-labs/flux-schnell',
    docs: 'https://replicate.com/explore',
  },
  {
    id: 'gemini-image',
    name: 'Gemini · Images',
    kind: 'image',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: '',
    docs: 'https://ai.google.dev/gemini-api/docs/image-generation',
  },
  {
    id: 'gemini-video',
    name: 'Gemini · Veo',
    kind: 'video',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: '',
    docs: 'https://ai.google.dev/gemini-api/docs/video',
  },
  {
    id: 'openai-video',
    name: 'OpenAI / compatible · Video',
    kind: 'video',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    docs: 'https://platform.openai.com/docs/guides/video-generation',
  },
  {
    id: 'gemini-music',
    name: 'Gemini · Lyria',
    kind: 'music',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'lyria-3.5',
    docs: 'https://ai.google.dev/gemini-api/docs/music-generation',
  },
  {
    id: 'eleven-music',
    name: 'ElevenLabs · Music',
    kind: 'music',
    baseUrl: 'https://api.elevenlabs.io/v1',
    model: 'music_v1',
    docs: 'https://elevenlabs.io/docs/api-reference/music/compose',
  },
  {
    id: 'openai-transcription',
    name: 'OpenAI / compatible · Transcription',
    kind: 'transcription',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-transcribe',
    docs: 'https://platform.openai.com/docs/guides/speech-to-text',
  },
  {
    id: 'deepgram',
    name: 'Deepgram · Transcription',
    kind: 'transcription',
    baseUrl: 'https://api.deepgram.com/v1',
    model: 'nova-3',
    docs: 'https://developers.deepgram.com/docs/pre-recorded-audio',
  },
  {
    id: 'assemblyai',
    name: 'AssemblyAI · Transcription',
    kind: 'transcription',
    baseUrl: 'https://api.assemblyai.com/v2',
    model: 'universal-2',
    docs: 'https://www.assemblyai.com/docs/pre-recorded-audio',
  },
  {
    id: 'openai-speech',
    name: 'OpenAI / compatible · Speech',
    kind: 'speech',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-tts',
    docs: 'https://platform.openai.com/docs/guides/text-to-speech',
  },
  {
    id: 'eleven-speech',
    name: 'ElevenLabs · Speech',
    kind: 'speech',
    baseUrl: 'https://api.elevenlabs.io/v1',
    model: 'eleven_multilingual_v2',
    docs: 'https://elevenlabs.io/docs/api-reference/text-to-speech/convert',
  },
];

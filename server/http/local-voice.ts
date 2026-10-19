import type { FastifyInstance } from 'fastify';
import type { Configuration } from '../services/settings.js';
import {
  listLocalVoices,
  localVoiceCapabilities,
  saveLocalVoice,
  useLocalVoice,
  previewLocalVoice,
} from '../services/local-voice-presets.js';
import { assert } from '../core/errors.js';
import { z } from 'zod';
export function localVoiceRoutes(app: FastifyInstance, config: Configuration, root: string) {
  app.get('/api/media/local-voice/voices', async () => ({
    voices: listLocalVoices(root),
    capabilities: localVoiceCapabilities,
    selected:
      config.get().media?.connections.find((c) => c.id === 'amadeus-local-cosyvoice')?.defaults
        .voice || 'default',
  }));
  app.post('/api/media/local-voice/voices', async (req) => {
    const fields: Record<string, string> = {};
    let audio: Buffer | undefined;
    for await (const part of req.parts({
      limits: {
        fileSize: localVoiceCapabilities.maxUploadBytes,
        files: 1,
        fields: 4,
        fieldSize: 8000,
        parts: 5,
      },
    })) {
      if (part.type === 'file') {
        assert(
          part.fieldname === 'audio' && !audio,
          'VOICE_UPLOAD',
          'Upload one reference recording.',
        );
        audio = await part.toBuffer();
      } else {
        assert(
          ['name', 'text', 'consent', 'language'].includes(part.fieldname),
          'VOICE_FIELD',
          'Unsupported voice field.',
        );
        fields[part.fieldname] = String(part.value);
      }
    }
    assert(audio, 'VOICE_UPLOAD', 'Choose a reference recording.');
    return saveLocalVoice(root, fields, audio);
  });
  app.post('/api/media/local-voice/use', async (req) =>
    useLocalVoice(config, root, z.object({ id: z.string().min(1) }).parse(req.body).id),
  );
  app.post('/api/media/local-voice/preview', async (req) => previewLocalVoice(root, req.body));
}

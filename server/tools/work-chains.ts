import { z } from 'zod';
import { relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { executionSettings } from '../../shared/execution.js';
import { NotStartedError } from '../core/errors.js';
import type { ToolRegistry, ToolContext } from './registry.js';
const json = (data: unknown) => ({ content: JSON.stringify(data) });
export function pythonCommand(code: string) {
  if (Buffer.byteLength(code, 'utf8') > 12000)
    throw new NotStartedError(
      'CODE_SIZE',
      'Split analysis into smaller scripts; maximum encoded source is 12 KB.',
    );
  // Only base64 crosses the shell parser. User code runs inside the selected container.
  return `python3 -c "import base64;exec(compile(base64.b64decode('${Buffer.from(code).toString('base64')}'),'<analysis>','exec'))"`;
}
export function pythonSource(command: string) {
  const encoded =
    /^python3 -c "import base64;exec\(compile\(base64\.b64decode\('([A-Za-z0-9+/=]+)'\),'<analysis>','exec'\)\)"$/.exec(
      command,
    )?.[1];
  if (!encoded) return undefined;
  const code = Buffer.from(encoded, 'base64').toString('utf8');
  return Buffer.byteLength(code, 'utf8') <= 12000 && pythonCommand(code) === command
    ? { language: 'python', code, source: 'exact-decoding-of-command' }
    : undefined;
}
function requireDocker(c: ToolContext) {
  if (executionSettings(c.config.get(), c.conversation).commandBackend !== 'docker')
    throw new NotStartedError(
      'ISOLATED_COMPUTE_REQUIRED',
      'Select Docker execution with a prepared Python image. This tool never falls back to host execution.',
    );
  if (!c.invokeTool) throw new NotStartedError('WORKFLOW_CONTEXT', 'Audited runtime required.');
}
export function frameScript(input: string, directory: string, times: number[], folder = 0) {
  return `import json, pathlib, subprocess, shutil
p=json.loads(${JSON.stringify(JSON.stringify({ input, directory, times, folder }))})
if not shutil.which('ffmpeg'): raise RuntimeError('DEPENDENCY_MISSING: ffmpeg must be installed in the configured container image')
out=pathlib.Path(p['directory']);out.mkdir(parents=True,exist_ok=False)
frames=[]
for i,t in enumerate(p['times']):
 f=out/('frame-%02d.png'%i)
 subprocess.run(['ffmpeg','-nostdin','-v','error','-ss',str(t),'-i',p['input'],'-frames:v','1','-vf','scale=1280:720:force_original_aspect_ratio=decrease','-n',str(f)],check=True,timeout=30)
 if not f.exists() or not f.stat().st_size: raise RuntimeError('No frame at requested timestamp '+str(t))
 frames.append({'path':'@'+str(p['folder'])+'/'+str(f),'requestedSeconds':t})
print(json.dumps({'frames':frames,'samplingOnly':True,'next':'Use read_image on returned workspace paths; frame extraction alone is not visual verification.'}))`;
}
export function installWorkChains(registry: ToolRegistry) {
  registry.add({
    name: 'inspect_tool_plan',
    effect: 'read',
    parallelSafe: true,
    description:
      'Validate a proposed multi-tool selection and arguments without executing, approving or probing tools. Include every requested independent operation; dependencies must refer to earlier call indexes. Reports missing/invalid tools and duplicate calls. Validation is not proof of goal coverage or permission to execute.',
    schema: z.object({
      calls: z
        .array(
          z.object({
            name: z.string(),
            arguments: z.record(z.string(), z.unknown()),
            dependsOn: z.array(z.number().int().min(0)).default([]),
          }),
        )
        .min(1)
        .max(40),
    }),
    run: (a, c) => {
      const seen = new Set<string>();
      const results = a.calls.map((call: any, index: number) => {
        const checked = registry.checkCall(call.name, call.arguments, c);
        const key = JSON.stringify([call.name, call.arguments]);
        const duplicate = seen.has(key);
        seen.add(key);
        return {
          index,
          ...checked,
          duplicate,
          invalidDependencies: call.dependsOn.filter((n: number) => n >= index),
        };
      });
      return json({
        results,
        valid: results.every((r: any) => r.valid && !r.invalidDependencies.length),
        executed: false,
        permissionsGranted: false,
      });
    },
  });
  registry.add({
    name: 'inspect_work_capabilities',
    effect: 'read',
    parallelSafe: true,
    description:
      'Inspect available tool chains for computation, browser, media and documents. Does not launch processes, disclose credentials or imply dependencies are installed. Use before work requiring several capabilities.',
    schema: z.object({}),
    run: (_a, c) => {
      const settings = c.config.get();
      const available = new Set(registry.specs(c).map((t) => t.name));
      const execution = executionSettings(settings, c.conversation);
      return json({
        tools: [...available],
        scheduling: {
          available: available.has('schedule_followup'),
          discovery: 'inspect_schedules',
          triggers: ['time', 'interval', 'background-command-completed'],
          requiresRunningService: true,
          notifications: 'in-app',
          note: 'Future model turns require a saved, approved schedule; background scripts alone do not perform model review.',
        },
        compute: {
          backend: execution.commandBackend,
          status:
            available.has('run_python') && execution.commandBackend === 'docker'
              ? 'configured-unverified'
              : 'blocked',
          required:
            'Prepared container with python3; use run_python to test imports. No automatic installation or host fallback.',
        },
        browser: {
          next: 'interaction_capabilities then mcp_tools for the enabled adapter; fetch failure never grants browser/network permissions',
        },
        transcription: {
          services: c.media.connections().filter((s: any) => s.kind === 'transcription'),
          next: 'import_media then transcribe_media then media_status; explicit upload approval applies',
        },
        video: {
          next: 'export_media then extract_media_frames then read_image; ffmpeg must exist in the container; requested timestamps are sampling, not full video coverage',
        },
        documents: {
          next: 'read_document for paginated text/OCR, read_image for actual image pixels',
        },
        permissionsGranted: false,
      });
    },
  });
  registry.add({
    name: 'run_python',
    effect: 'execute',
    description:
      'Run Python analysis in the configured offline Docker container via audited run_command. Never uses host Python. Requires python3 in the image; imports may fail if libraries are missing. No packages are installed automatically. Read/write only the mounted project folder; print structured results and artifact paths. Long work yields the SAME background job; wait before consuming outputs.',
    schema: z.object({
      code: z.string().min(1).max(10000),
      folder: z.number().int().min(0).default(0),
      timeoutSeconds: z.number().int().min(1).max(1800).default(120),
      reason: z.string().min(1),
    }),
    run: async (a, c) => {
      requireDocker(c);
      return c.invokeTool!(
        'run_command',
        {
          command: pythonCommand(a.code),
          folder: a.folder,
          timeoutSeconds: a.timeoutSeconds,
          requiredBackend: 'docker',
          reason: a.reason,
        },
        0,
      );
    },
  });
  registry.add({
    name: 'extract_media_audio',
    effect: 'execute',
    description:
      'Extract a bounded audio segment from a workspace video/audio using ffmpeg in offline Docker. Produces mono 16 kHz WAV (up to 10 minutes, under the transcription upload limit), preserving start/duration in the receipt. Then import_media and transcribe_media. Requires ffmpeg; never installs or falls back to host.',
    schema: z.object({
      path: z.string().min(1),
      folder: z.number().int().min(0).default(0),
      startSeconds: z.number().finite().min(0).max(86400).default(0),
      durationSeconds: z.number().finite().min(1).max(600).default(300),
      reason: z.string().min(1),
    }),
    run: async (a, c) => {
      requireDocker(c);
      const file = await c.files.resolve(a.path);
      const root = c.files.roots[a.folder];
      if (!root) throw new NotStartedError('FOLDER_UNKNOWN', 'Unknown project folder.');
      const rel = relative(root, file);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../'))
        throw new NotStartedError('MEDIA_FOLDER', 'Input must belong to the mounted folder.');
      const directory = '.amadeus-artifacts/audio-' + randomUUID();
      const data = JSON.stringify({
        input: rel.replace(/\\/g, '/'),
        directory,
        start: a.startSeconds,
        duration: a.durationSeconds,
        folder: a.folder,
      });
      const code = `import json,pathlib,subprocess,shutil,wave
p=json.loads(${JSON.stringify(data)})
if not shutil.which('ffmpeg'): raise RuntimeError('DEPENDENCY_MISSING: ffmpeg must exist in the container image')
d=pathlib.Path(p['directory']);d.mkdir(parents=True,exist_ok=False)
f=d/'segment.wav'
subprocess.run(['ffmpeg','-nostdin','-v','error','-ss',str(p['start']),'-i',p['input'],'-t',str(p['duration']),'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-n',str(f)],check=True,timeout=180)
with wave.open(str(f),'rb') as w: seconds=w.getnframes()/w.getframerate()
if seconds<=0: raise RuntimeError('No audio at requested interval')
print(json.dumps({'path':'@'+str(p['folder'])+'/'+str(f),'startSeconds':p['start'],'actualDurationSeconds':seconds,'next':'import_media then transcribe_media; this receipt is not a transcript.'}))`;
      return c.invokeTool!(
        'run_python',
        { code, folder: a.folder, timeoutSeconds: 200, reason: a.reason },
        0,
      );
    },
  });
  registry.add({
    name: 'extract_media_frames',
    effect: 'execute',
    description:
      'Sample a workspace video at explicit timestamps using ffmpeg in the configured Docker container. Never downloads codecs or falls back to host execution. Returns unique workspace frame paths for read_image. Export conversation media first. Missing codecs/timestamps fail explicitly; sampling cannot verify an entire video.',
    schema: z.object({
      path: z.string().min(1),
      folder: z.number().int().min(0).default(0),
      seconds: z.array(z.number().finite().min(0).max(86400)).min(1).max(8),
      reason: z.string().min(1),
    }),
    run: async (a, c) => {
      requireDocker(c);
      const file = await c.files.resolve(a.path);
      const root = c.files.roots[a.folder];
      if (!root) throw new NotStartedError('FOLDER_UNKNOWN', 'Unknown project folder.');
      const rel = relative(root, file);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../'))
        throw new NotStartedError('MEDIA_FOLDER', 'Input must belong to the mounted folder.');
      const directory = '.amadeus-artifacts/frames-' + randomUUID();
      return c.invokeTool!(
        'run_python',
        {
          code: frameScript(rel.replace(/\\/g, '/'), directory, a.seconds, a.folder),
          folder: a.folder,
          timeoutSeconds: Math.min(300, 40 * a.seconds.length),
          reason: a.reason,
        },
        0,
      );
    },
  });
}

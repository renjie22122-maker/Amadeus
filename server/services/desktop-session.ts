import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
export const computerActionSchema = {
  action: z.enum([
    'windows',
    'inspect',
    'activate',
    'cursor',
    'screenshot',
    'click',
    'double_click',
    'move',
    'type',
    'key',
    'scroll',
    'drag',
    'click_element',
    'click_image',
    'focus_element',
    'set_value',
    'invoke_element',
    'select_element',
    'expand_element',
    'collapse_element',
    'wait_for',
  ]),
  captureBackend: z.enum(['wgc', 'print-window']).default('wgc'),
  region: z
    .object({
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .strict()
    .optional(),
  scale: z.number().min(1).max(4).default(1),
  observeAfter: z.boolean().default(false),
  condition: z
    .object({
      name: z.string().max(500).optional(),
      automationId: z.string().max(500).optional(),
      role: z.string().max(100).optional(),
      value: z.string().max(2000).optional(),
      enabled: z.boolean().optional(),
      focused: z.boolean().optional(),
      selected: z.boolean().optional(),
      state: z.enum(['present', 'absent']).default('present'),
    })
    .strict()
    .refine(
      (c) => Boolean(c.name || c.automationId || c.role),
      'Identify a control by name, automationId or role',
    )
    .optional(),
  timeoutMs: z.number().int().min(0).max(10000).default(3000),
  windowId: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
  x: z.number().int().min(-32000).max(32000).optional(),
  y: z.number().int().min(-32000).max(32000).optional(),
  toX: z.number().int().min(-32000).max(32000).optional(),
  toY: z.number().int().min(-32000).max(32000).optional(),
  text: z.string().max(2000).optional(),
  key: z
    .string()
    .regex(
      /^(?:(?:CTRL|ALT|SHIFT)\+)*(?:[A-Z0-9]|ENTER|ESC|TAB|BACKSPACE|DELETE|HOME|END|PAGEUP|PAGEDOWN|UP|DOWN|LEFT|RIGHT|SPACE|F(?:[1-9]|1[0-2]))$/,
    )
    .optional(),
  pointerDurationMs: z.number().int().min(80).max(1500).optional(),
  button: z.enum(['left', 'right', 'middle']).default('left'),
  delta: z.number().int().min(-1200).max(1200).optional(),
  horizontal: z.boolean().default(false),
  maxControls: z.number().int().min(20).max(1000).default(300),
  screenshotId: z.string().uuid().optional(),
  observationId: z.string().uuid().optional(),
  elementIndex: z.number().int().min(0).optional(),
};
// Each MCP connection owns its observations. IDs cannot be used in another session.
export function createDesktopSession(
  native: (args: Record<string, unknown>) => Promise<any>,
  now = Date.now,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
) {
  const images = new Map<
    string,
    {
      at: number;
      windowId: string;
      capture: any;
      x: number;
      y: number;
      scaleX: number;
      scaleY: number;
      width: number;
      height: number;
    }
  >();
  const elementActions = [
    'click_element',
    'focus_element',
    'set_value',
    'invoke_element',
    'select_element',
    'expand_element',
    'collapse_element',
  ];
  function saveImage(result: any, original: any, windowId: string | undefined) {
    if (!windowId) return result;
    const screenshotId = randomUUID();
    if (images.size >= 8) images.delete(images.keys().next().value!);
    images.set(screenshotId, {
      at: now(),
      windowId,
      capture: {
        x: original.x,
        y: original.y,
        width: original.width,
        height: original.height,
        backend: original.capture,
        processId: original.processId,
      },
      x: result.x,
      y: result.y,
      scaleX: result.scaleX || 1,
      scaleY: result.scaleY || 1,
      width: result.width,
      height: result.height,
    });
    return { ...result, screenshotId, expiresInSeconds: 60 };
  }
  const observations = new Map<string, { at: number; windowId: string; controls: any[] }>();
  function remember(result: any, windowId: string) {
    const id = randomUUID();
    if (observations.size >= 8) observations.delete(observations.keys().next().value!);
    observations.set(id, { at: now(), windowId, controls: result.controls });
    return {
      ...result,
      observationId: id,
      expiresInSeconds: 60,
      controls: result.controls.map((e: any, elementIndex: number) => ({ ...e, elementIndex })),
    };
  }
  async function observe(windowId: string, maxControls: number) {
    return remember(await native({ action: 'inspect', windowId, maxControls }), windowId);
  }
  return async (raw: unknown) => {
    const a = z.object(computerActionSchema).strict().parse(raw);
    if (!['windows', 'cursor', 'screenshot'].includes(a.action) && !a.windowId)
      throw Error('DESKTOP_TARGET: select a window from windows first.');
    for (const [id, v] of observations) if (now() - v.at > 60_000) observations.delete(id);
    if (a.region && a.action !== 'screenshot')
      throw Error('DESKTOP_REGION: region only applies to screenshots.');
    if (a.action === 'wait_for' && !a.condition)
      throw Error('DESKTOP_CONDITION: wait_for requires an explicit condition.');
    async function finish(result: any) {
      const started = now();
      if (!a.condition && !a.observeAfter) return result;
      try {
        do {
          const observation = await observe(a.windowId!, a.maxControls);
          if (!a.condition) return { ...result, observation, applicationEffectVerified: false };
          const { state, ...match } = a.condition;
          const found = observation.controls.some(
            (e: any) => !e.password && Object.entries(match).every(([k, v]) => e[k] === v),
          );
          const satisfied = state === 'absent' ? !found && !observation.truncated : found;
          if (satisfied)
            return {
              ...result,
              verification: {
                status: 'matched',
                elapsedMs: now() - started,
                condition: a.condition,
              },
              observation,
            };
          if (now() - started >= a.timeoutMs)
            return {
              ...result,
              verification: { status: 'timeout', elapsedMs: now() - started },
              observation,
              guidance:
                'Condition not confirmed. Inspect before deciding what to do; no input was replayed.',
            };
          await sleep(Math.min(250, Math.max(0, a.timeoutMs - (now() - started))));
        } while (true);
      } catch {
        return {
          ...result,
          verification: { status: 'observation_failed' },
          guidance:
            'Observation failed after dispatch. Effect may have occurred; do not replay automatically.',
        };
      }
    }
    if (a.action === 'wait_for') return finish({ action: a.action, inputDispatched: false });
    if (a.action === 'click_image') {
      const image = a.screenshotId && images.get(a.screenshotId);
      if (!image || image.windowId !== a.windowId || now() - image.at > 60000)
        throw Error('DESKTOP_STALE: capture the target again.');
      if (
        a.x === undefined ||
        a.y === undefined ||
        a.x < 0 ||
        a.y < 0 ||
        a.x >= image.width ||
        a.y >= image.height
      )
        throw Error('DESKTOP_POINT: image pixel is outside the observed screenshot.');
      images.clear();
      observations.clear();
      return finish(
        await native({
          action: 'click',
          windowId: a.windowId,
          button: a.button,
          x: Math.floor(image.x + a.x / image.scaleX),
          y: Math.floor(image.y + a.y / image.scaleY),
          expectedCapture: image.capture,
          pointerDurationMs: a.pointerDurationMs,
        }),
      );
    }
    if (elementActions.includes(a.action)) {
      const saved = a.observationId && observations.get(a.observationId);
      if (!saved || saved.windowId !== a.windowId || a.elementIndex === undefined)
        throw Error('DESKTOP_STALE: inspect the target window again.');
      const previous = saved.controls[a.elementIndex];
      if (!previous?.runtimeId || previous.password || !previous.enabled)
        throw Error('DESKTOP_ELEMENT: unavailable, disabled or protected control.');
      const fresh = await native({ action: 'inspect', windowId: a.windowId, maxControls: 1000 });
      const current = fresh.controls.find(
        (e: any) => JSON.stringify(e.runtimeId) === JSON.stringify(previous.runtimeId),
      );
      if (
        !current ||
        ['name', 'role', 'x', 'y', 'width', 'height', 'enabled', 'password'].some(
          (k) => current[k] !== previous[k],
        )
      )
        throw Error('DESKTOP_STALE: control changed; inspect again.');
      if (current.width <= 0 || current.height <= 0)
        throw Error('DESKTOP_ELEMENT: control has no visible bounds.');
      observations.clear();
      images.clear();
      if (a.action === 'set_value' && a.text === undefined)
        throw Error('DESKTOP_TEXT: set_value requires literal text.');
      if (a.action !== 'click_element')
        return finish(
          await native({
            action: a.action,
            windowId: a.windowId,
            text: a.text,
            runtimeId: current.runtimeId,
            expectedName: current.name,
            expectedRole: current.role,
          }),
        );
      return finish(
        await native({
          action: 'click',
          windowId: a.windowId,
          button: a.button,
          x: Math.round(current.x + current.width / 2),
          y: Math.round(current.y + current.height / 2),
          ...(a.pointerDurationMs !== undefined ? { pointerDurationMs: a.pointerDurationMs } : {}),
        }),
      );
    }
    if (
      ['click', 'double_click', 'move', 'drag'].includes(a.action) &&
      (a.x === undefined || a.y === undefined)
    )
      throw Error('DESKTOP_POINT: x and y are required.');
    if (a.action === 'drag' && (a.toX === undefined || a.toY === undefined))
      throw Error('DESKTOP_POINT: drag endpoint required.');
    if (a.action === 'type' && a.text === undefined)
      throw Error('DESKTOP_TEXT: literal text required.');
    if (a.action === 'key' && !a.key) throw Error('DESKTOP_KEY: key required.');
    if (a.action === 'scroll' && a.delta === undefined)
      throw Error('DESKTOP_SCROLL: delta required.');
    if (!['windows', 'cursor', 'screenshot', 'inspect'].includes(a.action)) {
      observations.clear();
      images.clear();
    }
    const result = await native(a);
    if (a.action === 'inspect') return remember(result, a.windowId!);
    if (a.action === 'screenshot' && (a.region || a.scale !== 1)) {
      const region = a.region || { x: 0, y: 0, width: result.width, height: result.height };
      if (
        region.x + region.width > result.width ||
        region.y + region.height > result.height ||
        region.width * region.height * a.scale * a.scale > 16000000
      )
        throw Error('DESKTOP_REGION: crop exceeds capture or output exceeds 16 million pixels.');
      const width = Math.round(region.width * a.scale),
        height = Math.round(region.height * a.scale);
      const image = await sharp(Buffer.from(result.image, 'base64'))
        .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
        .resize(width, height)
        .png()
        .toBuffer();
      return saveImage(
        {
          ...result,
          image: image.toString('base64'),
          x: result.x + region.x,
          y: result.y + region.y,
          width,
          height,
          screenWidth: region.width,
          screenHeight: region.height,
          scaleX: width / region.width,
          scaleY: height / region.height,
          coordinates: 'screenX = x + imageX / scaleX; screenY = y + imageY / scaleY',
        },
        result,
        a.windowId,
      );
    }
    if (a.action === 'screenshot') return saveImage(result, result, a.windowId);
    if (['windows', 'cursor'].includes(a.action)) return result;
    return finish(result);
  };
}

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
  ]),
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
  button: z.enum(['left', 'right', 'middle']).default('left'),
  delta: z.number().int().min(-1200).max(1200).optional(),
  horizontal: z.boolean().default(false),
  maxControls: z.number().int().min(20).max(1000).default(300),
  observationId: z.string().uuid().optional(),
  elementIndex: z.number().int().min(0).optional(),
};
// Each MCP connection owns its observations. IDs cannot be used in another session.
export function createDesktopSession(
  native: (args: Record<string, unknown>) => Promise<any>,
  now = Date.now,
) {
  const observations = new Map<string, { at: number; windowId: string; controls: any[] }>();
  return async (raw: unknown) => {
    const a = z.object(computerActionSchema).strict().parse(raw);
    if (!['windows', 'cursor', 'screenshot'].includes(a.action) && !a.windowId)
      throw Error('DESKTOP_TARGET: select a window from windows first.');
    for (const [id, v] of observations) if (now() - v.at > 60_000) observations.delete(id);
    if (a.action === 'click_element') {
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
      return native({
        action: 'click',
        windowId: a.windowId,
        button: a.button,
        x: Math.round(current.x + current.width / 2),
        y: Math.round(current.y + current.height / 2),
      });
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
    if (!['windows', 'cursor', 'screenshot', 'inspect'].includes(a.action)) observations.clear();
    const result = await native(a);
    if (a.action === 'inspect') {
      const id = randomUUID();
      if (observations.size >= 8) observations.delete(observations.keys().next().value!);
      observations.set(id, { at: now(), windowId: a.windowId!, controls: result.controls });
      return {
        ...result,
        observationId: id,
        expiresInSeconds: 60,
        controls: result.controls.map((e: any, index: number) => ({ ...e, elementIndex: index })),
      };
    }
    return result;
  };
}

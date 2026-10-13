import { z } from 'zod';
import type { ToolRegistry } from '../tools/registry.js';
export const responseContractSchema = z.object({
  format: z.enum(['text', 'single-line', 'number', 'json']),
  prefix: z.string().max(100).default(''),
  userRequirement: z.string().min(1).max(1000),
});
export type ResponseContract = z.infer<typeof responseContractSchema>;
export function checkResponse(text: string, contract: ResponseContract): string[] {
  const errors: string[] = [];
  if (!text.startsWith(contract.prefix)) errors.push('Missing required prefix.');
  const body = (
    text.startsWith(contract.prefix) ? text.slice(contract.prefix.length) : text
  ).trim();
  if (!body) errors.push('Empty final answer.');
  if (contract.format === 'json')
    try {
      JSON.parse(body);
    } catch {
      errors.push('Return valid JSON only, without tags, fences or commentary.');
    }
  if (contract.format === 'number' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(body))
    errors.push(
      'Return one numeric value only; no formatting or units unless the output contract is changed to text.',
    );
  if (contract.format === 'single-line' && /[\r\n]/.test(body))
    errors.push('Return a single line.');
  if (
    contract.format === 'single-line' &&
    (/^(?:```|<\/?(?:answer|final)>)/i.test(body) || /^(\*\*|__)[\s\S]*\1$/.test(body))
  )
    errors.push('Unrequested presentation wrapper.');
  return errors;
}
export function installResponseContract(registry: ToolRegistry) {
  registry.add({
    name: 'set_response_contract',
    effect: 'read',
    description:
      'Record the user-requested final output format for this run only (text, single-line, number or JSON, with optional literal prefix). Quote the actual requirement. This validates shape, not factual correctness. Use text when tags/Markdown are requested; never invent a restrictive contract for ordinary chat. Replaced on new user input.',
    schema: responseContractSchema,
    run: (a, c) => {
      c.store.put('response-contract', { id: c.run.id, ...a });
      return {
        content: JSON.stringify({
          format: a.format,
          prefix: a.prefix,
          scope: 'current-run',
          semanticVerification: false,
        }),
      };
    },
  });
}

/** Persisted vectors are derived data. Reject one damaged row, not its whole corpus. */
export function validVector(values: unknown, dimension?: number): values is number[] {
  if (
    !Array.isArray(values) ||
    !values.length ||
    (dimension !== undefined && values.length !== dimension)
  )
    return false;
  let norm = 0;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    norm += value * value;
  }
  return Number.isFinite(norm) && norm > 0;
}
export function vectorRecord(
  raw: unknown,
  model?: string,
  dimension?: number,
): { model: string; values: number[] } | undefined {
  let value: any = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (
    !value ||
    typeof value.model !== 'string' ||
    (model !== undefined && value.model !== model) ||
    !validVector(value.values, dimension)
  )
    return undefined;
  return value;
}

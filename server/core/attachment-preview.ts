/** Budget is in UTF-16 code units, matching read_attachment offsets. Headers are outside this text budget. */
export function allocatePreviews(lengths: number[], budget = 15000) {
  const out = lengths.map(() => 0);
  const sizes = lengths
    .map((size, i) => ({ size, i }))
    .sort((a, b) => a.size - b.size || a.i - b.i);
  let remaining = budget;
  for (const [index, { size, i }] of sizes.entries()) {
    const share = Math.ceil(remaining / (sizes.length - index));
    out[i] = Math.min(size, share);
    remaining -= out[i];
  }
  return out;
}

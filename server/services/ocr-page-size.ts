// Bound both allocation and OCR dimensions before rendering, including oversized PDF page boxes.
function validateOcrPage(width: number, height: number): void {
  if (![width, height].every((n) => Number.isFinite(n) && n > 0))
    throw Error('DOCUMENT_PAGE_GEOMETRY: PDF page dimensions must be finite and positive.');
}

export interface OcrTile {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function ocrTiles(width: number, height: number): OcrTile[] {
  validateOcrPage(width, height);
  const size = 2500,
    overlap = 96,
    step = size - overlap;
  const columns = Math.max(1, Math.ceil((width - overlap) / step));
  const rows = Math.max(1, Math.ceil((height - overlap) / step));
  // Reject pathological geometry before allocating a giant array or raster.
  if (columns * rows > 256)
    throw Error(
      'DOCUMENT_OCR_GEOMETRY: Page requires more than 256 OCR tiles; inspect its page dimensions. No low-resolution substitute was indexed.',
    );
  const tiles: OcrTile[] = [];
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const x = column * step,
        y = row * step;
      tiles.push({
        x,
        y,
        width: Math.ceil(Math.min(size, width - x)),
        height: Math.ceil(Math.min(size, height - y)),
      });
    }
  return tiles;
}

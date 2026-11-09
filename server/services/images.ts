import sharp from 'sharp';
import { assert } from '../core/errors.js';
import type { FileScope } from './paths.js';
export function imageFormat(data: Buffer) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString())) return 'gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP')
    return 'webp';
  return undefined;
}
export interface ImageCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}
export async function cropImage(data: Buffer, crop: ImageCrop) {
  assert(
    data.length <= 25 * 1024 * 1024 && imageFormat(data),
    'IMAGE_SIZE',
    'Use a supported image under 25 MB.',
  );
  assert(
    Object.values(crop).every(Number.isInteger) &&
      crop.left >= 0 &&
      crop.top >= 0 &&
      crop.width > 0 &&
      crop.height > 0,
    'IMAGE_CROP',
    'Crop must use valid original pixel coordinates.',
  );
  const source = sharp(data, { limitInputPixels: 40_000_000, animated: false, failOn: 'error' });
  const meta = await source.metadata();
  assert(
    crop.left + crop.width <= (meta.width || 0) && crop.top + crop.height <= (meta.height || 0),
    'IMAGE_CROP',
    'Crop exceeds original image bounds.',
  );
  return source.extract(crop).png().toBuffer();
}
export async function normalizeImage(data: Buffer, crop?: ImageCrop) {
  if (crop) data = await cropImage(data, crop);
  assert(data.length <= 25 * 1024 * 1024, 'IMAGE_SIZE', 'Image input exceeds 25 MB.');
  const format = imageFormat(data);
  assert(
    format,
    'IMAGE_FORMAT',
    'Supported image content: PNG, JPEG, WebP and GIF. SVG/PDF must be converted first.',
  );
  const source = sharp(data, { limitInputPixels: 40_000_000, failOn: 'error', animated: false });
  const metadata = await source.metadata();
  assert(
    metadata.format === format && metadata.width && metadata.height,
    'IMAGE_DECODE',
    'Image is corrupt or has inconsistent format metadata.',
  );
  const rotated = [5, 6, 7, 8].includes(metadata.orientation || 1);
  const width = rotated ? metadata.height : metadata.width,
    height = rotated ? metadata.width : metadata.height;
  const ratio = Math.min(1, Math.sqrt(640000 / (width * height)), 1600 / Math.max(width, height));
  const pipeline = source
    .rotate()
    .resize({
      width: Math.max(1, Math.floor(width * ratio)),
      height: Math.max(1, Math.floor(height * ratio)),
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' });
  let normalized = await pipeline.clone().png().toBuffer({ resolveWithObject: true }),
    mime = 'image/png';
  if (normalized.data.length > 1048576) {
    normalized = await pipeline.clone().jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true });
    mime = 'image/jpeg';
  }
  assert(
    normalized.data.length <= 1048576,
    'IMAGE_SIZE',
    'Normalized image exceeds 1 MB; use a smaller crop.',
  );
  return {
    url: 'data:' + mime + ';base64,' + normalized.data.toString('base64'),
    metadata: {
      format,
      ...(crop ? { crop, coordinateSpace: 'original-unrotated-pixels' } : {}),
      width: normalized.info.width,
      height: normalized.info.height,
      originalWidth: width,
      originalHeight: height,
      bytes: normalized.data.length,
      resized: ratio < 1,
      firstFrameOnly: (metadata.pages || 1) > 1,
    },
  };
}
export async function readScopedImage(
  files: FileScope,
  path: string,
  crop?: ImageCrop,
  frames?: number[],
) {
  return normalizeImageSequence(await files.readBytes(path, 25 * 1024 * 1024), crop, frames);
}

/** Chronological contact sheet keeps tool images bounded without hiding motion. */
export async function normalizeImageSequence(data: Buffer, crop?: ImageCrop, frames?: number[]) {
  assert(
    data.length <= 25 * 1024 * 1024 && imageFormat(data),
    'IMAGE_SIZE',
    'Use a supported image under 25 MB.',
  );
  const meta = await sharp(data, { limitInputPixels: 40000000, failOn: 'error' }).metadata();
  const pages = meta.pages || 1;
  const indexes = frames?.length
    ? [...new Set(frames)].sort((a, b) => a - b)
    : Array.from({ length: Math.min(pages, 8) }, (_, i) =>
        Math.round((i * (pages - 1)) / Math.max(1, Math.min(pages, 8) - 1)),
      );
  assert(
    indexes.length <= 12 && indexes.every((i) => Number.isInteger(i) && i >= 0 && i < pages),
    'IMAGE_FRAMES',
    'Select up to 12 valid zero-based frame indices.',
  );
  if (pages === 1) return normalizeImage(data, crop);
  const tiles: { input: Buffer; left: number; top: number }[] = [];
  const columns = Math.min(4, indexes.length),
    cellWidth = 320,
    cellHeight = 260;
  for (const [position, page] of indexes.entries()) {
    let frame = await sharp(data, { page, pages: 1, limitInputPixels: 40000000, failOn: 'error' })
      .png()
      .toBuffer();
    if (crop) frame = await cropImage(frame, crop);
    const tile = await sharp(frame)
      .rotate()
      .resize(320, 240, { fit: 'contain', background: '#ffffff' })
      .png()
      .toBuffer();
    const left = (position % columns) * cellWidth,
      top = Math.floor(position / columns) * cellHeight;
    tiles.push({ input: tile, left, top });
    const label = Buffer.from(
      `<svg width="320" height="20"><rect width="100%" height="100%" fill="white"/><text x="4" y="15" font-size="14" fill="black">Frame ${page + 1}</text></svg>`,
    );
    tiles.push({ input: label, left, top: top + 240 });
  }
  const sheet = await sharp({
    create: {
      width: columns * cellWidth,
      height: Math.ceil(indexes.length / columns) * cellHeight,
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite(tiles)
    .png()
    .toBuffer();
  const normalized = await normalizeImage(sheet);
  return {
    ...normalized,
    metadata: {
      ...normalized.metadata,
      format: imageFormat(data)!,
      firstFrameOnly: indexes.length === 1,
      animation: {
        totalFrames: pages,
        sampledFrames: indexes,
        complete: indexes.length === pages,
        frameTimesMs: indexes.map((i) =>
          (meta.delay || []).slice(0, i).reduce((sum, n) => sum + n, 0),
        ),
        durationMs: meta.delay?.reduce((sum, n) => sum + n, 0),
        layout:
          'left-to-right, then top-to-bottom; labels are one-based frame numbers; unsampled motion is unknown',
      },
    },
  };
}

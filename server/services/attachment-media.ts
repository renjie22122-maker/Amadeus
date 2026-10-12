/** Identify supported media containers from bytes, never trust the browser MIME alone. */
export function attachmentMediaType(b: Buffer): string | undefined {
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return 'image/gif';
  const tag = b.toString('ascii', 0, 4),
    form = b.toString('ascii', 8, 12);
  if (tag === 'RIFF' && form === 'WEBP') return 'image/webp';
  if (tag === 'RIFF' && form === 'WAVE') return 'audio/wav';
  if (tag === 'fLaC') return 'audio/flac';
  if (tag === 'OggS') return b.includes(Buffer.from('theora')) ? 'video/ogg' : 'audio/ogg';
  if (b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 255 && (b[1] & 254) === 250))
    return 'audio/mpeg';
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp')
    return /^M4A|^M4B/.test(form) ? 'audio/mp4' : 'video/mp4';
  if (
    b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) &&
    b.subarray(0, 4096).includes(Buffer.from('webm'))
  )
    return 'video/webm';
}
export function mediaAttachmentText(id: string, mime: string) {
  return (
    '[Local media attachment: ' +
    mime +
    '. Reference: attachment:' +
    id +
    '. Use inspect_media to inspect metadata, export_media to copy bytes into the authorized workspace, or this reference in generate_media. Images can be read with read_image. Audio/video content has not been transcribed or visually analyzed; export for authorized transcription or frame extraction. No transcript is implied.]'
  );
}

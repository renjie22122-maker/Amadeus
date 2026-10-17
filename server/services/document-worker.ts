import { extract } from './documents.js';
process.once(
  'message',
  async ({ path, checkpointDirectory }: { path: string; checkpointDirectory?: string }) => {
    try {
      const text = await extract(path, {
        ocr: true,
        checkpointDirectory,
        onTile: (page, total, tile, tiles) =>
          process.send?.({ type: 'tile', page, total, tile, tiles }),
        onPage: (page, total) => process.send?.({ type: 'page', page, total }),
      });
      if (text.length > 5_000_000)
        throw Error('Extracted text exceeds 5 million characters; split the source.');
      process.send?.({ text }, () => process.exit(0));
    } catch (e: any) {
      process.send?.({ error: String(e.message || e).slice(0, 500) }, () => process.exit(1));
    }
  },
);

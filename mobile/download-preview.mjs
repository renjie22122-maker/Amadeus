// Optional local-only distribution endpoint for the single preview APK, not a file browser.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const file = fileURLToPath(
  new URL('../release/Amadeus-Android-0.2.0-preview.apk', import.meta.url),
);
createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method) || req.url !== '/Amadeus.apk') {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': statSync(file).size,
      'Content-Disposition': 'attachment; filename="Amadeus-preview.apk"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else
      createReadStream(file)
        .on('error', () => res.destroy())
        .pipe(res);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(8822, '127.0.0.1');

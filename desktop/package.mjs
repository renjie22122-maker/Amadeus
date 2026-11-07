import { build, Platform, Arch } from 'electron-builder';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..');
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Build the Windows x64 installer on Windows x64 with Node 24+.');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24+ is required.');
const runtime = join(root, '.desktop-runtime');
await mkdir(runtime, { recursive: true });
// Preserve the standalone Node ABI used to install native backend dependencies.
await copyFile(process.execPath, join(runtime, 'node.exe'));
await copyFile(join(dirname(process.execPath), 'LICENSE'), join(runtime, 'NODE-LICENSE.txt'));
await writeFile(
  join(runtime, 'version.json'),
  JSON.stringify({ node: process.version, arch: process.arch }),
);
const png = await sharp(
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" rx="56" fill="#7860b5"/><path d="M63 191 112 61h32l49 130h-34l-10-31h-48l-10 31zm47-59h30l-15-46z" fill="white"/></svg>',
  ),
)
  .png()
  .toBuffer();
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
await writeFile(join(runtime, 'icon.ico'), Buffer.concat([ico, png]));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await build({
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  publish: 'never',
  config: {
    appId: 'io.amadeus.desktop',
    productName: 'Amadeus',
    electronVersion: manifest.devDependencies.electron,
    directories: { output: 'release', buildResources: '.desktop-runtime' },
    extraMetadata: { main: 'desktop/main.mjs', author: 'Amadeus contributors' },
    asar: false,
    npmRebuild: false,
    files: [
      'build/**/*',
      'dist/**/*',
      'desktop/main.mjs',
      'desktop/backend.mjs',
      'desktop/preload.cjs',
      'desktop/icon.png',
      'desktop/boot.html',
      'desktop/boot.css',
      'desktop/boot.js',
      'package.json',
      'LICENSE',
      '!node_modules/onnxruntime-node/bin/napi-v3/darwin/**/*',
      '!node_modules/onnxruntime-node/bin/napi-v3/linux/**/*',
      '!node_modules/onnxruntime-node/bin/napi-v3/win32/arm64/**/*',
    ],
    extraResources: [
      {
        from: '.desktop-runtime',
        to: 'runtime',
        filter: ['node.exe', 'NODE-LICENSE.txt', 'version.json'],
      },
    ],
    win: {
      target: 'nsis',
      icon: '.desktop-runtime/icon.ico',
      artifactName: 'Amadeus-Setup-${version}-${arch}.${ext}',
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      runAfterFinish: false,
      deleteAppDataOnUninstall: false,
    },
  },
});

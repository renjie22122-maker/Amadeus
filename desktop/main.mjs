import { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell } from 'electron';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { DesktopBackend } from './backend.mjs';

app.setName('Amadeus');
if (process.env.AMADEUS_DESKTOP_USER_DATA)
  app.setPath('userData', resolve(process.env.AMADEUS_DESKTOP_USER_DATA));
const primary = app.requestSingleInstanceLock();
let window,
  tray,
  backend,
  quitting = false,
  quitPending = false;
function show() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
if (!primary) app.quit();
else {
  app.on('second-instance', show);
  app.on('activate', show);
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (quitPending) return;
    quitPending = true;
    // Release the window's live HTTP/SSE connections before awaiting Fastify shutdown.
    if (window && !window.isDestroyed()) window.destroy();
    void (backend?.stop() ?? Promise.resolve())
      .then(() => {
        quitting = true;
        tray?.destroy();
        app.quit();
      })
      .catch((error) => {
        quitPending = false;
        show();
        dialog.showErrorBox('Amadeus', error.message);
      });
  });
  void app.whenReady().then(async () => {
    try {
      const root = resolve(import.meta.dirname, '..');
      const node =
        process.env.AMADEUS_NODE_BINARY ||
        join(process.resourcesPath, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
      if (!existsSync(node) || resolve(node) === resolve(process.execPath))
        throw new Error('A standalone Node runtime is required. Start with pnpm desktop.');
      const directory = resolve(
        process.env.AGENTDEMO_DATA_DIR || join(app.getPath('userData'), 'agent'),
      );
      backend = new DesktopBackend({ node, root, directory });
      window = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 800,
        minHeight: 560,
        title: 'Amadeus',
        backgroundColor: '#212121',
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#212121', symbolColor: '#eeeeee', height: 38 },
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
          preload: join(import.meta.dirname, 'preload.cjs'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webviewTag: false,
          backgroundThrottling: false,
        },
      });
      const icon = nativeImage.createFromPath(join(import.meta.dirname, 'icon.png'));
      tray = new Tray(icon);
      tray.setToolTip('Amadeus · 关闭窗口后继续运行');
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '打开 Amadeus', click: show },
          { label: '打开数据目录', click: () => void shell.openPath(directory) },
          { type: 'separator' },
          { label: '退出 Amadeus（停止本地任务）', click: () => app.quit() },
        ]),
      );
      tray.on('double-click', show);
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Amadeus',
            submenu: [
              { label: '隐藏到托盘（任务继续）', click: () => window.hide() },
              { label: '打开数据目录', click: () => void shell.openPath(directory) },
              { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
            ],
          },
          { role: 'editMenu' },
          {
            label: '视图',
            submenu: [
              { role: 'reload' },
              { role: 'resetZoom' },
              { role: 'zoomIn' },
              { role: 'zoomOut' },
            ],
          },
        ]),
      );
      window.on('close', (event) => {
        if (!quitting) {
          event.preventDefault();
          window.hide();
        }
      });
      window.webContents.on('will-attach-webview', (event) => event.preventDefault());
      const external = async (value) => {
        let url;
        try {
          url = new URL(value);
        } catch {
          return;
        }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
        const answer = await dialog.showMessageBox(window, {
          type: 'question',
          message: '在默认浏览器中打开外部链接？',
          detail: url.href,
          buttons: ['取消', '打开'],
          defaultId: 0,
          cancelId: 0,
        });
        if (answer.response === 1) await shell.openExternal(url.href);
      };
      window.webContents.setWindowOpenHandler(({ url }) => {
        void external(url);
        return { action: 'deny' };
      });
      window.webContents.on('will-navigate', (event, url) => {
        if (!backend.url || new URL(url).origin !== backend.url) {
          event.preventDefault();
          void external(url);
        }
      });
      window.webContents.on('will-redirect', (event, url) => {
        if (!backend.url || new URL(url).origin !== backend.url) event.preventDefault();
      });
      const session = window.webContents.session;
      session.setPermissionCheckHandler(
        (_contents, permission, origin) => origin === backend.url && permission === 'media',
      );
      session.setPermissionRequestHandler(async (contents, permission, callback, details) => {
        if (
          contents !== window.webContents ||
          permission !== 'media' ||
          (details.requestingUrl && new URL(details.requestingUrl).origin !== backend.url) ||
          !details.mediaTypes?.length ||
          details.mediaTypes.some((type) => type !== 'audio')
        ) {
          callback(false);
          return;
        }
        const answer = await dialog.showMessageBox(window, {
          message: '允许 Amadeus 使用麦克风？',
          buttons: ['拒绝', '允许'],
          defaultId: 0,
          cancelId: 0,
        });
        callback(answer.response === 1);
      });
      backend.on('stopped', ({ expected }) => {
        if (!expected && !quitPending) {
          show();
          dialog.showErrorBox(
            'Amadeus',
            '后台服务已停止。请退出并重新打开应用；已有任务不会自动重新提交。日志保存在数据目录。',
          );
        }
      });
      const url = await backend.start();
      await window.loadURL(url);
      show();
    } catch (error) {
      dialog.showErrorBox('Amadeus 启动失败', error.message);
      app.quit();
    }
  });
}

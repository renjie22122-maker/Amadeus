import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  dialog,
  shell,
  ipcMain,
  desktopCapturer,
} from 'electron';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DesktopBackend, AttachedDesktopBackend } from './backend.mjs';
import { desktopMenus } from './menus.mjs';

app.setName('Amadeus');
if (process.env.AMADEUS_DESKTOP_USER_DATA)
  app.setPath('userData', resolve(process.env.AMADEUS_DESKTOP_USER_DATA));
const primary = app.requestSingleInstanceLock();
let window,
  dot,
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
    if (dot && !dot.isDestroyed()) dot.destroy();
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
      if (
        !process.env.AMADEUS_BACKEND_URL &&
        (!existsSync(node) || resolve(node) === resolve(process.execPath))
      )
        throw new Error('A standalone Node runtime is required. Start with pnpm desktop.');
      const directory = resolve(
        process.env.AGENTDEMO_DATA_DIR || join(app.getPath('userData'), 'agent'),
      );
      backend = process.env.AMADEUS_BACKEND_URL
        ? new AttachedDesktopBackend(process.env.AMADEUS_BACKEND_URL)
        : new DesktopBackend({ node, root, directory });
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
      const dotPreference = join(app.getPath('userData'), 'personal-dot.json');
      const toggleDot = () => {
        if (!backend.url) return;
        if (dot && !dot.isDestroyed()) {
          dot.destroy();
          writeFileSync(dotPreference, 'false');
          return;
        }
        dot = new BrowserWindow({
          width: 360,
          height: 440,
          minWidth: 260,
          minHeight: 180,
          title: 'Amadeus Dot',
          alwaysOnTop: true,
          skipTaskbar: true,
          autoHideMenuBar: true,
          webPreferences: {
            preload: join(import.meta.dirname, 'preload.cjs'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webviewTag: false,
          },
        });
        dot.setMenu(null);
        dot.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        dot.webContents.on('will-navigate', (event) => event.preventDefault());
        dot.webContents.on('will-redirect', (event) => event.preventDefault());
        dot.webContents.on('will-attach-webview', (event) => event.preventDefault());
        dot.on('close', () => {
          if (!quitPending) writeFileSync(dotPreference, 'false');
        });
        void dot.loadURL(backend.url + '/?surface=dot');
        writeFileSync(dotPreference, 'true');
      };
      ipcMain.handle('amadeus:capture-context', async (event) => {
        if (
          !dot ||
          dot.isDestroyed() ||
          event.sender !== dot.webContents ||
          event.senderFrame !== dot.webContents.mainFrame ||
          !backend.url ||
          new URL(event.senderFrame.url).origin !== backend.url
        )
          return null;
        const consent = await dialog.showMessageBox(dot, {
          message: '选择要截取的窗口或屏幕。截图先在圆点中预览，发送后才交给模型。',
          buttons: ['取消', '选择窗口或屏幕'],
          defaultId: 0,
          cancelId: 0,
        });
        if (consent.response !== 1) return null;
        const sources = await desktopCapturer.getSources({
          types: ['window', 'screen'],
          thumbnailSize: { width: 1600, height: 1000 },
        });
        const choices = sources.filter((source) => !source.thumbnail.isEmpty());
        if (!choices.length) return null;
        const choice = await dialog.showMessageBox(dot, {
          message: '截取哪个窗口或屏幕？',
          buttons: ['取消', ...choices.map((source) => source.name)],
          defaultId: 0,
          cancelId: 0,
        });
        return choices[choice.response - 1]?.thumbnail.toDataURL() || null;
      });
      ipcMain.on('amadeus:open-agent', (event) => {
        if (
          !dot ||
          dot.isDestroyed() ||
          event.sender !== dot.webContents ||
          event.senderFrame !== dot.webContents.mainFrame ||
          !backend.url ||
          new URL(event.senderFrame.url).origin !== backend.url
        )
          return;
        show();
        window.webContents.send('amadeus:command', 'personal');
      });
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
        Menu.buildFromTemplate(
          desktopMenus({
            command: (id) => {
              if (backend.url && window.webContents.getURL().startsWith(backend.url + '/')) {
                show();
                window.webContents.send('amadeus:command', id);
              }
            },
            hide: () => window.hide(),
            openData: () => void shell.openPath(directory),
            quit: () => app.quit(),
            toggleDot,
            about: () =>
              void dialog.showMessageBox(window, {
                title: 'About Amadeus',
                message: 'Amadeus',
                detail: `Version ${app.getVersion()}\nLocal workspace and background agent. Closing the window keeps tasks running; quitting stops the local service.`,
              }),
          }),
        ),
      );
      window.on('close', (event) => {
        if (!quitting) {
          event.preventDefault();
          window.hide();
        }
      });
      ipcMain.on('amadeus:menu', (event, label) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          !backend.url
        )
          return;
        if (new URL(event.senderFrame.url).origin !== backend.url) return;
        if (!['File', 'Edit', 'View', 'Go', 'Help'].includes(label)) return;
        Menu.getApplicationMenu()
          ?.items.find((item) => item.label === label)
          ?.submenu?.popup({ window });
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
          (contents !== window.webContents &&
            (!dot || dot.isDestroyed() || contents !== dot.webContents)) ||
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
      await window.loadFile(join(import.meta.dirname, 'boot.html'));
      show();
      await window.webContents.executeJavaScript(
        "window.setBootStage(2, 'Starting your local service…', '正在启动本地后台服务…')",
      );
      const url = await backend.start();
      await window.webContents.executeJavaScript(
        "window.setBootStage(3, 'Loading conversations and tools…', '正在加载会话与工具…')",
      );
      await window.loadURL(url);
      if (
        process.env.AMADEUS_SHOW_DOT === '1' ||
        (existsSync(dotPreference) && readFileSync(dotPreference, 'utf8') === 'true')
      )
        toggleDot();
      show();
    } catch (error) {
      dialog.showErrorBox('Amadeus 启动失败', error.message);
      app.quit();
    }
  });
}

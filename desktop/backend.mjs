import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';

/** Owns exactly one standalone Node service. Window visibility is not a lifecycle signal. */
export class DesktopBackend extends EventEmitter {
  constructor({ node, root, directory, readyTimeout = 90000, shutdownTimeout = 60000 }) {
    super();
    Object.assign(this, { node, root, directory, readyTimeout, shutdownTimeout });
  }
  start() {
    if (this.stopping) return Promise.reject(new Error('Service is stopping.'));
    if (this.starting) return this.starting;
    this.starting = this.launch();
    return this.starting;
  }
  async launch() {
    const logs = join(this.directory, 'logs');
    mkdirSync(logs, { recursive: true });
    const out = openSync(join(logs, 'desktop-server.log'), 'a');
    const err = openSync(join(logs, 'desktop-server-errors.log'), 'a');
    const env = { ...process.env, AGENTDEMO_DATA_DIR: this.directory, PORT: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    let child;
    try {
      child = spawn(this.node, [join(this.root, 'build/server/main.js')], {
        cwd: this.root,
        env,
        windowsHide: true,
        stdio: ['ignore', out, err, 'ipc'],
      });
    } finally {
      closeSync(out);
      closeSync(err);
    }
    this.child = child;
    this.exited = new Promise((resolve) => child.once('close', resolve));
    child.once('close', (code, signal) => {
      this.child = undefined;
      this.url = undefined;
      this.starting = undefined;
      this.emit('stopped', { code, signal, expected: !!this.stopping });
    });
    child.once('error', () => {
      this.starting = undefined;
    });
    return new Promise((resolve, reject) => {
      const finish = (error, url) => {
        clearTimeout(timer);
        child.off('message', ready);
        child.off('error', failed);
        child.off('close', exited);
        if (error) reject(error);
        else {
          this.url = url;
          resolve(url);
        }
      };
      const failed = () =>
        finish(new Error('Could not start the Node service. Check the desktop logs.'));
      const exited = () =>
        finish(new Error('Service exited before becoming ready. Check the desktop logs.'));
      const ready = (message) => {
        if (message?.type !== 'amadeus:ready') return;
        try {
          const url = new URL(message.url);
          if (
            url.protocol !== 'http:' ||
            url.hostname !== '127.0.0.1' ||
            !url.port ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search ||
            url.hash
          )
            throw new Error('Invalid service address.');
          finish(undefined, url.origin);
        } catch {
          finish(new Error('Invalid service readiness message.'));
        }
      };
      const timer = setTimeout(() => {
        // Disconnect asks even a still-booting server to close, without killing unrelated processes.
        if (child.connected) child.disconnect();
        finish(new Error('Service startup timed out. Check the desktop logs.'));
      }, this.readyTimeout);
      child.on('message', ready);
      child.once('error', failed);
      child.once('close', exited);
    });
  }
  stop() {
    if (this.stopping) return this.stopping;
    if (!this.child) return Promise.resolve();
    const child = this.child;
    this.stopping = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              'Service is still shutting down. Tasks are not force-killed; try quitting again.',
            ),
          ),
        this.shutdownTimeout,
      );
      this.exited.then(() => {
        clearTimeout(timer);
        resolve();
      });
      if (child.connected)
        child.send({ type: 'amadeus:shutdown' }, (error) => {
          if (error && child.connected) child.disconnect();
        });
    }).finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
}

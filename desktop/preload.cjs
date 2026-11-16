const { contextBridge, ipcRenderer } = require('electron');
// Fixed menu names and one-way commands only. Never expose IPC objects or events.
contextBridge.exposeInMainWorld(
  'amadeusDesktop',
  Object.freeze({
    platform: process.platform,
    openAgent() {
      ipcRenderer.send('amadeus:open-agent');
    },
    openMenu(label) {
      if (['File', 'Edit', 'View', 'Go', 'Help'].includes(label))
        ipcRenderer.send('amadeus:menu', label);
    },
    onCommand(callback) {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, command) => {
        if (typeof command === 'string') callback(command);
      };
      ipcRenderer.on('amadeus:command', listener);
      return () => ipcRenderer.removeListener('amadeus:command', listener);
    },
  }),
);

const { contextBridge } = require('electron');
// Read-only identity. The renderer receives no Node or IPC capabilities.
contextBridge.exposeInMainWorld('amadeusDesktop', Object.freeze({ platform: process.platform }));

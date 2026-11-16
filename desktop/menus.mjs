// Keep native actions in the main process; renderer commands carry no arguments.
export function desktopMenus({ command, hide, openData, quit, about }) {
  return [
    {
      label: 'File',
      submenu: [
        { label: 'New chat', click: () => command('new-chat') },
        { label: 'New workspace…', click: () => command('new-project') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => command('settings') },
        { label: 'Open data folder', click: openData },
        { type: 'separator' },
        { label: 'Hide to tray (keep tasks running)', click: hide },
        { label: 'Quit Amadeus', accelerator: 'CmdOrCtrl+Q', click: quit },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Search chats', click: () => command('search') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle sidebar', accelerator: 'CmdOrCtrl+B', click: () => command('sidebar') },
        { label: 'Site map', click: () => command('siteMap') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'reload' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        ['spaces', 'Spaces'],
        ['background', 'Scheduled & background tasks'],
        ['plugins', 'Plugins'],
        ['assistants', 'Assistants'],
        ['codeReview', 'Code review'],
        ['security', 'Security integrations'],
        ['knowledge', 'Knowledge'],
        ['memory', 'Memory'],
        ['chatConnections', 'Channels'],
      ].map(([id, label]) => ({ label, click: () => command(id) })),
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Feature guide', click: () => command('siteMap') },
        { label: 'Integration availability', click: () => command('security') },
        { label: 'About Amadeus', click: about },
      ],
    },
  ];
}

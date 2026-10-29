import { prepareDesktopCapture } from '../server/services/desktop-capture.js';
await prepareDesktopCapture();
console.log('Windows Graphics Capture helper ready. No screen captured.');

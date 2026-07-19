import { registerHyperellipse } from 'hyperellipse';

import { startApp } from './ui/app';

// corner-shape polyfill for Firefox/Safari; no-op where native support exists
registerHyperellipse();

startApp(document.getElementById('app')!);

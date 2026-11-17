import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import './desktop.css';
const App = lazy(() => import('./App').then((m) => ({ default: m.App })));
const PersonalDot = lazy(() =>
  import('./components/PersonalDot').then((m) => ({ default: m.PersonalDot })),
);
const dot =
  'amadeusDesktop' in window && new URLSearchParams(location.search).get('surface') === 'dot';
if ('amadeusDesktop' in window) document.documentElement.dataset.desktop = 'true';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense fallback={<div role="status">Loading...</div>}>
      {dot ? <PersonalDot /> : <App />}
    </Suspense>
  </React.StrictMode>,
);

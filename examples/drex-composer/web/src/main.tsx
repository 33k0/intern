import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import '@fontsource-variable/eb-garamond/wght.css';
import '@fontsource-variable/eb-garamond/wght-italic.css';
import './styles/base.css';
import { controller } from './controller';
import { App } from './panel/App';

// Socket (or mock feed) and audio engine start loading before the first render.
controller.boot();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import '@apygee/core/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { UiProvider } from '@apygee/core';
import { App } from './App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('pto-demo: #root element not found');
}

createRoot(container).render(
  <StrictMode>
    <UiProvider injectStyles={false}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </UiProvider>
  </StrictMode>,
);

import './shared/zodConfig';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerServiceWorker } from './flows/push';
import './shared/styles/tokens.css';

// 推播與點通知開收件匣要有 service worker；它不快取任何東西，demo 也可以註冊。
registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

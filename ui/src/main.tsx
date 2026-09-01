/**
 * Entry point.
 *
 * The worklet processor is served from `public/` at a stable, unhashed URL.
 * `addModule` loads it into a separate global scope with its own module
 * graph, so it has to arrive untransformed — a bundled and wrapped processor
 * never reaches `registerProcessor`, and the streaming path would silently
 * fall back to buffered playback in every production build.
 *
 * @module
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { GatewayClient } from './api/client.js';
import { browserBackend } from './audio/player.js';
import './styles.css';


const container = document.getElementById('root');
if (!container) throw new Error('the #root element is missing from index.html');

const WORKLET_URL = '/pcm-processor.js';

createRoot(container).render(
  <StrictMode>
    <App
      client={new GatewayClient()}
      audio={browserBackend(WORKLET_URL)}
      storage={window.localStorage}
    />
  </StrictMode>,
);

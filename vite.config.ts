/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Plugin } from 'vite';

/** Dev server only: POST /__dev/save?name=x writes the body to .dev-media/x (for checking exports with ffprobe). */
function devSave(): Plugin {
  return {
    name: 'polish-dev-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/save', async (req, res) => {
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name')?.replace(/[^\w.\- ()]/g, '') || 'out.bin';
        await pipeline(req, createWriteStream(`.dev-media/${name}`));
        res.end('ok');
      });
    },
  };
}

// COOP/COEP make the page cross-origin isolated (SharedArrayBuffer for multithreaded WASM);
// `credentialless` still lets us fetch Hugging Face model files without CORP headers.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  plugins: [react(), tailwindcss(), devSave()],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});

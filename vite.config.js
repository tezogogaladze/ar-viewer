import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: true,   // expose on local network
    https: true,  // required for WebXR on Android
    port: 3000,
  },
  preview: {
    host: true,
    https: true,
    port: 3000,
  },
});

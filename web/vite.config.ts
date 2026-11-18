import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { msw } from 'msw/vite'

// The Rust server terminates TLS on the console listener in development.
const API_TARGET = process.env.RUSTRMM_DEV_API ?? 'https://localhost:8443'

/**
 * Mock mode only: top-level navigations never reach the MSW service worker, so the dev server
 * stands in for the two that leave the SPA — the OIDC start redirect (answered with the login-page
 * hash the real callback produces) and the self-hosted API docs page.
 */
function mockNavigations(): PluginOption {
  return {
    name: 'rustrmm-mock-navigations',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const start = /^\/api\/v1\/auth\/oidc\/([^/]+)\/start$/.exec(url.pathname)
        if (start) {
          // Failures can be previewed by opening /login#sso_error=<code> directly.
          const hash = `sso_challenge=ssomock.${encodeURIComponent(start[1])}.${Date.now().toString(36)}&mfa=required&methods=totp,recovery_code`
          res.statusCode = 303
          res.setHeader('Location', `/login#${hash}`)
          res.end()
          return
        }
        if (url.pathname === '/api/docs' || url.pathname === '/api/docs/') {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(
            '<!doctype html><meta charset="utf-8"><title>API docs (mock)</title><body style="font:14px system-ui;margin:3rem;max-width:40rem">' +
              '<h1>RustRMM API documentation</h1><p>The real server serves its self-hosted docs page here, rendered from <code>/api/openapi.json</code> (OpenAPI 3.1).</p>' +
              '<p>The mock dev server has no OpenAPI document. Run the console against a server (<code>npm run dev</code>) to browse it.</p><p><a href="/settings/api-tokens">Back to the console</a></p>',
          )
          return
        }
        next()
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const isMock = mode === 'mock'
  const plugins: PluginOption[] = [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ]
  // The mock service worker script is only served in mock mode and never emitted in builds.
  if (isMock) plugins.push(msw({ mode: 'worker-only' }), mockNavigations())

  return {
    plugins,
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: isMock
        ? undefined
        : {
            '/api': {
              target: API_TARGET,
              secure: false,
              ws: true,
              // The server enforces a strict Origin check; present dev requests as same-origin.
              configure: (proxy) => {
                proxy.on('proxyReq', (req) => req.setHeader('origin', API_TARGET))
                proxy.on('proxyReqWs', (req) => req.setHeader('origin', API_TARGET))
              },
            },
          },
    },
    build: {
      outDir: 'dist',
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 900,
    },
  }
})

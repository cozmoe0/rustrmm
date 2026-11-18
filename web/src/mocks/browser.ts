/** Starts the MSW service worker in `npm run dev:mock`. Never bundled in production builds. */
export async function startMocking() {
  const [{ setupWorker }, { handlers }, { applyMockResetParam }] = await Promise.all([
    import('msw/browser'),
    import('./handlers'),
    import('./db'),
  ])
  applyMockResetParam()
  const worker = setupWorker(...handlers)
  await worker.start({ onUnhandledFrame: 'bypass', quiet: true })
}

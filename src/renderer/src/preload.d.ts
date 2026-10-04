/**
 * Global type declarations for the Electron preload API.
 *
 * The preload script exposes `window.api` via contextBridge.
 * This file provides the TypeScript declaration so renderer code
 * can access `window.api` without type errors.
 *
 * TODO: replace `any` with a precise interface extracted from
 *       src/preload/index.ts for stronger type safety.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Window {
  api: any
}

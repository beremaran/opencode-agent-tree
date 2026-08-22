/**
 * OpenCode 1 server entrypoint.
 *
 * This separate entry lets the package root use OpenCode 2's `{ id, setup }`
 * contract while older OpenCode releases continue to resolve a callable
 * plugin through `main` or the `./server` export.
 */
export { default } from "./index.ts"

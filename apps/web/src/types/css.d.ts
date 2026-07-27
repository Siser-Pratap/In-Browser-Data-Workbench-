/**
 * Side-effect CSS imports.
 *
 * Next's bundler handles these, but `tsc --noEmit` runs without it and would
 * otherwise fail on `import './globals.css'`.
 */
declare module '*.css';

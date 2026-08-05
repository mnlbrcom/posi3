/**
 * Two rules, and a reason for each.
 *
 * `no-undef` catches a name that does not exist in the scope it is used in.
 * That is invisible to tests until the branch actually runs, and on a show that
 * is the worst possible moment to find out: `_forward` announced a
 * destination's recovery with `dest`, a name belonging to a loop in another
 * method, and the first time a destination genuinely recovered — a VPN changing
 * the routes under a running link — the ReferenceError took the whole bridge
 * down with the encoder still streaming.
 *
 * `no-unused-vars` is the mirror image: a name defined and never used. It never
 * crashes anything — the harm is to the reader, because a dead name is a false
 * claim about the code. The log view imported `checkbox` from the day it was
 * migrated and never once called it, which advertised a control the screen does
 * not have; when a checkbox was then mentioned in a discussion of that screen,
 * the operator reasonably asked "what checkbox?". The sweep that added this
 * rule found nine such names — four in src/, five in tests — and removed them,
 * so it gates from zero.
 *
 * Deliberately not a style config. Everything else here is a judgement the
 * codebase already makes consistently, and a gate that fails on taste gets
 * switched off. These fire only on code that cannot work or words that are not
 * true.
 *
 * The globals are written out rather than pulled from the `globals` package, so
 * this stays a single dependency. Add a name when the platform genuinely
 * provides it — never to silence a real miss.
 */

const timers = {
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly'
};

const universal = {
  ...timers,
  console: 'readonly',
  performance: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  crypto: 'readonly',
  structuredClone: 'readonly',
  WebSocket: 'readonly'
};

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'build/**', 'input/**']
  },

  // The bridge, the server, the desktop shell and the tools: CommonJS on Node.
  {
    files: ['src/core/**/*.js', 'src/server/**/*.js', 'src/shared/**/*.js',
      'src/desktop/**/*.js', 'tools/**/*.js', 'bin/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...universal,
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly'
      }
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'error' }
  },

  // The web UI: ES modules in a browser, and the same UI in the desktop window.
  {
    files: ['src/web/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...universal,
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        history: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        getComputedStyle: 'readonly',
        EventSource: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        FormData: 'readonly',
        sessionStorage: 'readonly',
        localStorage: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        SVGElement: 'readonly',
        // CSS.escape, used to build the banner's [data-key] selector safely.
        // Supported in Blink, WebKit and Gecko alike.
        CSS: 'readonly'
      }
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'error' }
  }
];

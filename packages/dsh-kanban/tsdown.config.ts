/**
 * Standalone tsdown config for the dsh-kanban plugin.
 *
 * Two halves:
 *  - node half: src/index.ts -> lib/index.js (ESM, runs in the host process)
 *  - browser half: src/client/index.ts -> lib/client.js (CJS closure-factory
 *    artifact for the GUI's window.__ModuleLoader__; externals resolve through
 *    the loader's module table, mirroring the dsh-web-ui client-bundle preset)
 */
import type { UserConfig } from 'tsdown'

/** Browser platform modules the shell shares into the frozen module table. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
] as const

const PLUGIN_ID = 'dsh-kanban'

const node: UserConfig = {
  name: PLUGIN_ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // The cordis framework resolves at runtime from the dsh profile tree, never
  // from this repo's install.
  external: ['@deepseek-ai/cordis'],
}

const client: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...PLATFORM_MODULES],
  // Platform modules stay external (the loader's require answers them);
  // everything else inlines into the single client.js artifact.
  noExternal: (id: string) => (PLATFORM_MODULES.includes(id as never) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [node, client]

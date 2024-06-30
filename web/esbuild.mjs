import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  outfile: 'dist/index.mjs',
  platform: 'browser',
  external: ['react'],
  // minify: true,
  tsconfig: './tsconfig.json'
})

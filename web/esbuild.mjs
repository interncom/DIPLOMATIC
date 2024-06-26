import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  outfile: 'dist/index.js',
  platform: 'browser',
  external: ['react'],
  // minify: true,
  tsconfig: './tsconfig.json'
})

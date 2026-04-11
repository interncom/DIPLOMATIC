import * as esbuild from "esbuild";

const result = await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  outfile: "dist/index.mjs",
  platform: "browser",
  target: 'esnext',
  external: ["react", "@noble/hashes"],
  // minify: true,
  tsconfig: "./tsconfig.json",
  metafile: true,
});

console.log(await esbuild.analyzeMetafile(result.metafile));

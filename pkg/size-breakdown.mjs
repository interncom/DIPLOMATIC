import { readFile, unlink } from "node:fs/promises";
import { basename } from "node:path";

/** @param {string} path */
function packageName(path) {
  // Prefer the package under the last node_modules segment
  // (handles bun's node_modules/.bun/@scope+name@ver/node_modules/@scope/name/...)
  const re = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//g;
  let m;
  let last = null;
  while ((m = re.exec(path)) !== null) {
    if (m[1] === ".bun") continue;
    last = m[1];
  }
  return last;
}

/** @param {string} path */
function firstPartyBucket(path) {
  if (path.startsWith("shared/") || path.includes("/shared/")) return "shared";
  if (path.startsWith("web/") || path.includes("/web/src/")) return "web";
  if (path.startsWith("cli/") || path.includes("/cli/src/")) return "cli";
  if (path.startsWith("bun/") || path.includes("/bun/src/")) return "bun";
  return null;
}

/** @param {number} n */
function padNum(n, w) {
  return String(n).padStart(w);
}

/**
 * Print bundle weight by npm dependency (and first-party buckets).
 * @param {string} metafilePath path written by bun --metafile=
 * @param {string} [label] optional label for the table header
 * @param {{ keep?: boolean }} [opts]
 */
export async function printSizeBreakdown(metafilePath, label, opts = {}) {
  const raw = await readFile(metafilePath, "utf8");
  const meta = JSON.parse(raw);

  const outputs = Object.entries(meta.outputs ?? {});
  if (outputs.length === 0) {
    console.log(`(no outputs in metafile ${metafilePath})`);
    if (!opts.keep) await unlink(metafilePath).catch(() => {});
    return;
  }

  for (const [outPath, out] of outputs) {
    /** @type {Map<string, number>} */
    const byPkg = new Map();
    /** @type {Map<string, number>} */
    const byFirst = new Map();
    let other = 0;
    let accounted = 0;

    for (const [inPath, info] of Object.entries(out.inputs ?? {})) {
      const n = info.bytesInOutput ?? 0;
      if (n <= 0) continue;
      accounted += n;
      const pkg = packageName(inPath);
      if (pkg) {
        byPkg.set(pkg, (byPkg.get(pkg) ?? 0) + n);
        continue;
      }
      const fp = firstPartyBucket(inPath);
      if (fp) {
        byFirst.set(fp, (byFirst.get(fp) ?? 0) + n);
        continue;
      }
      other += n;
    }

    const total = out.bytes ?? accounted;
    const title = label ?? basename(outPath);
    const numW = String(total).length;

    console.log(`\n${title}  ${total} bytes`);

    const pkgRows = [...byPkg.entries()].sort((a, b) => b[1] - a[1]);
    if (pkgRows.length) {
      console.log("  dependencies (bytes in output):");
      for (const [name, bytes] of pkgRows) {
        const pct = ((100 * bytes) / total).toFixed(1).padStart(5);
        console.log(`    ${padNum(bytes, numW)}  ${pct}%  ${name}`);
      }
    }

    const fpRows = [...byFirst.entries()].sort((a, b) => b[1] - a[1]);
    if (fpRows.length || other > 0) {
      console.log("  first-party / other:");
      for (const [name, bytes] of fpRows) {
        const pct = ((100 * bytes) / total).toFixed(1).padStart(5);
        console.log(`    ${padNum(bytes, numW)}  ${pct}%  ${name}`);
      }
      if (other > 0) {
        const pct = ((100 * other) / total).toFixed(1).padStart(5);
        console.log(`    ${padNum(other, numW)}  ${pct}%  (other)`);
      }
    }

    // Overlap / rounding: minifier may make sum of parts != total
    const parts = accounted;
    if (parts !== total) {
      const rest = total - parts;
      const pct = ((100 * rest) / total).toFixed(1).padStart(5);
      console.log(`    ${padNum(rest, numW)}  ${pct}%  (shared/runtime)`);
    }

    const depSum = pkgRows.reduce((s, [, b]) => s + b, 0);
    const fpSum = fpRows.reduce((s, [, b]) => s + b, 0);
    console.log(
      `  totals: deps ${depSum} · first-party ${fpSum}${other ? ` · other ${other}` : ""} · file ${total}`,
    );
  }

  if (!opts.keep) await unlink(metafilePath).catch(() => {});
}

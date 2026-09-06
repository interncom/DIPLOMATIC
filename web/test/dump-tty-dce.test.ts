// Web minify must DCE dumpToTty's /dev/tty write (DIP_CLI_DUMP=false).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Status } from "../src/shared/consts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const enclaveSrc = fileURLToPath(
  new URL("../src/shared/crypto/enclave.ts", import.meta.url),
);

let tmp: string | undefined;

afterEach(() => {
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  Reflect.deleteProperty(globalThis, "DIP_CLI_DUMP");
});

// Browser-minify Enclave with the web bundle's DIP_CLI_DUMP=false define.
function buildWebEnclave(): string {
  tmp = mkdtempSync(join(tmpdir(), "dip-dump-dce-"));
  const out = join(tmp, "enclave.mjs");
  execFileSync("bun", [
    "build",
    "--target",
    "browser",
    "--format",
    "esm",
    "--minify",
    "--define",
    "DIP_CLI_DUMP=false",
    "--outfile",
    out,
    enclaveSrc,
  ], { cwd: repo, encoding: "utf8" });
  return out;
}

function assertNoTtyWrite(js: string, label: string) {
  expect(js.includes("/dev/tty"), `${label} must not contain /dev/tty`).toBe(
    false,
  );
  expect(js.includes("DIP_CLI_DUMP"), `${label} must inline DIP_CLI_DUMP`)
    .toBe(false);
}

describe("web dumpToTty DCE", () => {
  it("build scripts pin DIP_CLI_DUMP=false", () => {
    const web = readFileSync(join(repo, "pkg/build-web.mjs"), "utf8");
    const cli = readFileSync(join(repo, "pkg/build-cli.mjs"), "utf8");
    expect(web).toContain("--define DIP_CLI_DUMP=false");
    expect(cli).toContain("--define DIP_CLI_DUMP=false");
  });

  it("minified Enclave has no tty write and dumpToTty is NotImplemented", async () => {
    const out = buildWebEnclave();
    const js = readFileSync(out, "utf8");
    assertNoTtyWrite(js, "minified Enclave");
    expect(js).toContain("dumpToTty");

    const mod: unknown = await import(pathToFileURL(out).href);
    expect(mod).toMatchObject({ Enclave: expect.any(Function) });
    if (typeof mod !== "object" || mod === null || !("Enclave" in mod)) {
      throw new Error("Enclave export missing");
    }
    const Enc = mod.Enclave;
    if (typeof Enc !== "function" || !("fromBytes" in Enc)) {
      throw new Error("Enclave.fromBytes missing");
    }
    const fromBytes = Enc.fromBytes;
    if (typeof fromBytes !== "function") {
      throw new Error("Enclave.fromBytes missing");
    }
    const pair: unknown = fromBytes(new Uint8Array(32).fill(1));
    if (!Array.isArray(pair)) throw new Error("fromBytes not ValStat");
    const e = pair[0];
    const st = pair[1];
    expect(st).toBe(Status.Success);
    if (e === null || typeof e !== "object" || !("dumpToTty" in e)) {
      throw new Error("enclave missing dumpToTty");
    }
    const dump = e.dumpToTty;
    if (typeof dump !== "function") throw new Error("dumpToTty not a function");
    expect(await dump.call(e)).toBe(Status.NotImplemented);

    Object.defineProperty(globalThis, "DIP_CLI_DUMP", {
      value: true,
      configurable: true,
      writable: true,
    });
    expect(await dump.call(e)).toBe(Status.NotImplemented);
  });

  it.skipIf(
    !existsSync(join(repo, "pkg/dist/web/index.mjs")) ||
      !existsSync(join(repo, "pkg/dist/web/worker.mjs")),
  )("pkg dist web/worker omit the tty write", () => {
    assertNoTtyWrite(
      readFileSync(join(repo, "pkg/dist/web/index.mjs"), "utf8"),
      "pkg/dist/web/index.mjs",
    );
    assertNoTtyWrite(
      readFileSync(join(repo, "pkg/dist/web/worker.mjs"), "utf8"),
      "pkg/dist/web/worker.mjs",
    );
  });
});

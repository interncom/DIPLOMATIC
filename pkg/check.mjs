import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

async function checkWebBundle() {
  console.log("Checking web bundle...");
  try {
    const content = await readFile("./dist/web/index.mjs", "utf8");
    if (content.length < 1000) throw new Error("Bundle too small");
    if (!content.includes("genWebClient")) throw new Error("genWebClient not found in bundle");
    if (!content.includes("SyncClient")) throw new Error("SyncClient not found in bundle");
    console.log("✓ Web bundle content verified");
  } catch (error) {
    console.error("✗ Web bundle check failed:", error.message);
    process.exit(1);
  }
}

async function checkCLIBundle() {
  console.log("Checking CLI bundle...");
  try {
    const content = await readFile("./dist/cli/index.mjs", "utf8");
    if (content.length < 1000) throw new Error("Bundle too small");
    if (!content.includes("CLIClient")) throw new Error("CLIClient not found in bundle");
    if (!content.includes("initCLIOrPanic")) throw new Error("initCLIOrPanic not found in bundle");
    if (!content.includes("runBunHost")) throw new Error("runBunHost not found in bundle");
    console.log("✓ CLI bundle content verified");
  } catch (error) {
    console.error("✗ CLI bundle check failed:", error.message);
    process.exit(1);
  }
}

async function checkHostBinary() {
  console.log("Checking host binary...");
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["./dist/cli/bin/host.js"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000, // 3 second timeout
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code, signal) => {
      if (code === null && signal === "SIGTERM") {
        // Timeout - this is expected
        if (stdout.includes("DIPLOMATIC PARCEL SERVICE ACTIVE")) {
          console.log("✓ Host binary started successfully");
          resolve();
        } else {
          console.error("✗ Host binary did not start properly");
          reject(new Error("Host startup message not found"));
        }
      } else {
        console.error("✗ Host binary failed:", code, signal, stderr);
        reject(new Error(`Host exited with code ${code}`));
      }
    });

    child.on("error", (error) => {
      console.error("✗ Host binary spawn error:", error.message);
      reject(error);
    });
  });
}

async function main() {
  console.log("Running package sanity checks...\n");

  await checkWebBundle();
  await checkCLIBundle();
  await checkHostBinary();

  console.log("\n✓ All checks passed!");
}

main().catch((error) => {
  console.error("Check failed:", error);
  process.exit(1);
});
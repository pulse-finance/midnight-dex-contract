import { rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  COMPACT_COMPILER_VERSION,
  compactArtifactsDirectory,
  ensureCompactBinary,
} from "./compact-install.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const targets = {
  amm: {
    source: "src/ShieldedBatcherAMM.compact",
    output: "dist/amm",
  },
  faucet: {
    source: "src/Faucet.compact",
    output: "dist/faucet",
  },
  orderbook: {
    source: "src/OneCoinOrderBook.compact",
    output: "dist/orderbook",
  },
};

const defaultTargets = ["faucet", "amm", "orderbook"];

function runCompact(binaryPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        COMPACT_DIRECTORY: compactArtifactsDirectory(),
      },
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`compact ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
    });
    child.on("error", reject);
  });
}

async function buildTarget(name, compactBinary) {
  const target = targets[name];
  if (!target) {
    const supportedTargets = Object.keys(targets).join(", ");
    throw new Error(`Unknown build target "${name}". Expected one of: ${supportedTargets}`);
  }

  const sourcePath = path.join(repoRoot, target.source);
  const outputPath = path.join(repoRoot, target.output);

  await rm(outputPath, { recursive: true, force: true });
  console.error(`[dex-contract] Compiling ${name}`);
  await runCompact(compactBinary, ["compile", `+${COMPACT_COMPILER_VERSION}`, sourcePath, outputPath]);
}

const selectedTargets = process.argv.slice(2);
const buildList = selectedTargets.length > 0 ? selectedTargets : defaultTargets;
const compactBinary = await ensureCompactBinary();

for (const targetName of buildList) {
  await buildTarget(targetName, compactBinary);
}

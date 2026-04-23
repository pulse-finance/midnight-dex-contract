import { createWriteStream } from "node:fs";
import { access, chmod, mkdtemp, mkdir, rm, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const COMPACT_TOOL_VERSION = "0.5.1";
export const COMPACT_COMPILER_VERSION = "0.30.0";
const INSTALLER_URL = `https://github.com/midnightntwrk/compact/releases/download/compact-v${COMPACT_TOOL_VERSION}/compact-installer.sh`;
const PLATFORM_ARCH = `${process.platform}-${process.arch}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function defaultCacheHome() {
  if (process.env.XDG_CACHE_HOME) {
    return process.env.XDG_CACHE_HOME;
  }

  const home = os.homedir();

  if (process.platform === "darwin") {
    return path.join(home, "Library", "Caches");
  }

  return path.join(home, ".cache");
}

function installationRoot() {
  const configured = process.env.PULSE_DEX_CONTRACT_COMPACT_HOME;
  const base = configured ?? path.join(defaultCacheHome(), "pulsefinance", "midnight-dex-contract");
  return path.join(base, `compact-v${COMPACT_TOOL_VERSION}`, PLATFORM_ARCH);
}

function compactBinaryPath() {
  return path.join(installationRoot(), "bin", "compact");
}

export function compactArtifactsDirectory() {
  return path.join(installationRoot(), "artifacts");
}

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function downloadFile(url, destination, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) {
      reject(new Error(`Too many redirects while downloading ${url}`));
      return;
    }

    const request = https.get(
      url,
      {
        headers: {
          "user-agent": "@pulsefinance/dex-contract installer",
        },
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          const redirectedUrl = new URL(response.headers.location, url).toString();
          resolve(downloadFile(redirectedUrl, destination, redirectCount + 1));
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode ?? "unknown"}`));
          return;
        }

        const output = createWriteStream(destination, { mode: 0o700 });

        output.on("finish", () => {
          output.close();
          resolve();
        });
        output.on("error", reject);
        response.on("error", reject);
        response.pipe(output);
      },
    );

    request.on("error", reject);
  });
}

function runInstaller(scriptPath, installDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [scriptPath], {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        COMPACT_UNMANAGED_INSTALL: installDir,
        XDG_CONFIG_HOME: path.join(installationRoot(), "config"),
      },
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Compact installer exited with code ${code ?? "unknown"}`));
    });
    child.on("error", reject);
  });
}

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

export async function ensureCompactBinary() {
  const binaryPath = compactBinaryPath();
  if (!(await fileExists(binaryPath))) {
    if (!["linux", "darwin"].includes(process.platform)) {
      throw new Error(
        `Unsupported platform ${process.platform}. Midnight currently documents Compact installs for Linux and macOS.`,
      );
    }

    const installDir = path.dirname(binaryPath);
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), "compact-installer-"));
    const installerScriptPath = path.join(tempWorkspace, "compact-installer.sh");

    console.error(
      `[dex-contract] Installing Compact ${COMPACT_TOOL_VERSION} for ${PLATFORM_ARCH} into ${installDir}`,
    );

    try {
      await mkdir(installDir, { recursive: true });
      await downloadFile(INSTALLER_URL, installerScriptPath);
      await chmod(installerScriptPath, 0o700);
      await runInstaller(installerScriptPath, installDir);
    } finally {
      await unlink(installerScriptPath).catch(() => {});
      await rm(tempWorkspace, { recursive: true, force: true }).catch(() => {});
    }

    if (!(await fileExists(binaryPath))) {
      throw new Error(`Compact installation finished without producing ${binaryPath}`);
    }
  }

  await mkdir(compactArtifactsDirectory(), { recursive: true });
  console.error(
    `[dex-contract] Ensuring Compact compiler ${COMPACT_COMPILER_VERSION} in ${compactArtifactsDirectory()}`,
  );
  await runCompact(binaryPath, ["update", COMPACT_COMPILER_VERSION]);

  return binaryPath;
}

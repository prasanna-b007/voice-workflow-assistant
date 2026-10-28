// Fetches the llama.cpp server that runs Sonix's built-in AI model (see
// src-tauri/src/ai.rs) into src-tauri/resources/llama, which the installer ships.
// Runs before every `tauri dev` / `tauri build` and does nothing once the files
// are there. Pinned to one release and checked against its SHA-256, so every
// build ships the same, tested engine.
//
// The Vulkan build uses the GPU when there is one and falls back to the CPU
// (it carries CPU backends for every x64 processor generation), so one engine
// works on every Windows laptop.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BUILD = "b11606";
const ZIP = `llama-${BUILD}-bin-win-vulkan-x64.zip`;
const URL = `https://github.com/ggml-org/llama.cpp/releases/download/${BUILD}/${ZIP}`;
const SHA256 = "a70498cb1ba105c4e0abca28e5d784bd6aafbabc870b41237855ffa28a6d6627";

// The server and the libraries it loads; the other tools in the archive aren't needed.
const KEEP = (name) =>
  /^llama-server(-impl)?\.(exe|dll)$/.test(name) ||
  /^(llama|llama-common|mtmd|ggml|ggml-base|ggml-vulkan|libomp)\.dll$/.test(name) ||
  /^ggml-cpu-[\w-]+\.dll$/.test(name) ||
  /^LICENSE/.test(name);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "src-tauri", "resources", "llama");
const stamp = join(dest, "VERSION");

if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === BUILD) process.exit(0);

console.log(`Fetching the llama.cpp ${BUILD} server for the built-in AI…`);
const res = await fetch(URL);
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${URL}`);
const zip = Buffer.from(await res.arrayBuffer());

const hash = createHash("sha256").update(zip).digest("hex");
if (hash !== SHA256) throw new Error(`${ZIP} has SHA-256 ${hash}, expected ${SHA256}`);

const work = join(tmpdir(), `sonix-llama-${BUILD}-${process.pid}`);
mkdirSync(work, { recursive: true });
try {
  writeFileSync(join(work, ZIP), zip);
  // Windows 10+ ships bsdtar, which reads zip files. Called by full path: Git Bash's
  // GNU tar, often first on PATH, can't.
  const tar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  execFileSync(tar, ["-xf", ZIP], { cwd: work, stdio: "inherit" });

  // Clear the previous engine but keep the placeholder that lets a fresh clone build.
  mkdirSync(dest, { recursive: true });
  for (const old of readdirSync(dest)) if (old !== ".gitkeep") rmSync(join(dest, old), { force: true });
  const files = readdirSync(work).filter(KEEP);
  if (!files.includes("llama-server.exe")) throw new Error(`llama-server.exe not found in ${ZIP}`);
  for (const file of files) copyFileSync(join(work, file), join(dest, file));
  writeFileSync(stamp, `${BUILD}\n`);
  console.log(`Copied ${files.length} files to ${dest}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

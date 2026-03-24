import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

// 改为使用系统临时目录或用户目录，避免权限问题
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 优先使用 OpenClaw workspace 目录下的缓存，或系统临时目录
function getCacheBaseDir(): string {
  // 尝试使用用户主目录下的 .openclaw/lingzhu-cache
  const homeDir = os.homedir();
  const openclawCache = path.join(homeDir, ".openclaw", "lingzhu-cache", "img");
  return openclawCache;
}

const IMAGE_CACHE_DIR = getCacheBaseDir();
const DEFAULT_MAX_AGE_HOURS = 24;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

let lastCleanupAt = 0;

export function getImageCacheDir(): string {
  return IMAGE_CACHE_DIR;
}

export async function ensureImageCacheDir(): Promise<string> {
  await fs.mkdir(IMAGE_CACHE_DIR, { recursive: true });
  return IMAGE_CACHE_DIR;
}

export async function cleanupImageCache(maxAgeHours = DEFAULT_MAX_AGE_HOURS): Promise<{
  removed: number;
  kept: number;
}> {
  const cacheDir = await ensureImageCacheDir();
  const entries = await fs.readdir(cacheDir, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  const maxAgeMs = Math.max(1, maxAgeHours) * 60 * 60 * 1000;
  let removed = 0;
  let kept = 0;

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const filePath = path.join(cacheDir, entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        await fs.unlink(filePath);
        removed += 1;
      } else {
        kept += 1;
      }
    } catch {
      // Ignore per-file cleanup failures.
    }
  }

  lastCleanupAt = now;
  return { removed, kept };
}

export async function cleanupImageCacheIfNeeded(maxAgeHours = DEFAULT_MAX_AGE_HOURS): Promise<void> {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) {
    return;
  }

  await cleanupImageCache(maxAgeHours).catch(() => undefined);
}

export async function summarizeImageCache(): Promise<{
  dir: string;
  files: number;
}> {
  const cacheDir = await ensureImageCacheDir();
  const entries = await fs.readdir(cacheDir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile()).length;
  return {
    dir: cacheDir,
    files,
  };
}

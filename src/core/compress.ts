// When a transfer is compressed: only when it's big enough to matter and mostly made of data that compresses.
// Photos, videos, music and archives are already compressed; compressing them again costs time and saves nothing.

const ALREADY_COMPRESSED = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "heic", "avif",
  "mp4", "mov", "mkv", "webm", "avi", "m4v",
  "mp3", "m4a", "aac", "ogg", "opus", "flac",
  "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "jar", "apk",
  "pdf", "docx", "xlsx", "pptx", "woff", "woff2",
]);

/** Below this, the time saved can't outweigh the work. */
export const COMPRESS_MIN_BYTES = 1024 * 1024;

export function worthCompressing(files: readonly { name: string; size: number }[]): boolean {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total < COMPRESS_MIN_BYTES) return false;
  const compressible = files.filter((f) => !ALREADY_COMPRESSED.has(f.name.split(".").at(-1)?.toLowerCase() ?? "")).reduce((sum, f) => sum + f.size, 0);
  return compressible * 2 >= total;
}

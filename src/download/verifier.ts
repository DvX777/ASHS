// src/download/verifier.ts — File integrity verification
import fs from "fs";
import crypto from "crypto";

/**
 * Compute SHA-256 checksum of a file.
 */
export async function computeSHA256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Verify a downloaded file against expected size (within 10KB tolerance).
 */
export function verifySizeApprox(filePath: string, expectedBytes: number): boolean {
  if (!expectedBytes || expectedBytes <= 0) return true; // No size info — skip check
  const stat = fs.statSync(filePath);
  return Math.abs(stat.size - expectedBytes) <= 10_240;
}

/**
 * Move a file from src to dest, creating dest dirs if needed.
 */
export async function moveFile(src: string, dest: string): Promise<void> {
  const dir = dest.substring(0, dest.lastIndexOf("/"));
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.renameSync(src, dest); // Fast: same filesystem
  } catch {
    // Cross-device: copy then delete
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

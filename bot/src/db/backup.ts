import { dirname, join } from "node:path";
import { config } from "../config.js";
import { db } from "./client.js";

/** Rolling second-file path next to the live DB (e.g. salawat.backup.db). */
export function getBackupPath(): string {
  const dir = dirname(config.dbPath);
  return join(dir, "salawat.backup.db");
}

/** Online WAL-safe backup via better-sqlite3 (no sqlite3 CLI required). */
export async function backupDatabase(): Promise<string> {
  const dest = getBackupPath();
  await db.backup(dest);
  return dest;
}

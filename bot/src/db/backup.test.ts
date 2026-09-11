import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// A real file, not :memory: — db.backup() has nowhere to write otherwise, and
// the rotation directory is derived from the DB path.
const dataDir = mkdtempSync(join(tmpdir(), "salawat-backup-test-"));
process.env.BOT_TOKEN ??= "backup-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH = join(dataDir, "salawat.db");

const {
  BACKUP_KEEP,
  backupDatabase,
  backupFilename,
  getBackupDir,
  listBackups,
  newestBackupAgeMs,
  pruneBackups,
} = await import("./backup.js");
const { shouldRunStartupBackup } = await import("../scheduler/backup.js");

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function clearBackups(): void {
  const dir = getBackupDir();
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** A backup file that already exists, aged `ageMs` into the past. */
function seedBackup(name: string, ageMs: number): string {
  const dir = getBackupDir();
  const path = join(dir, name);
  writeFileSync(path, "");
  const seconds = (Date.now() - ageMs) / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

beforeEach(() => {
  clearBackups();
});

describe("backupFilename", () => {
  it("is a UTC stamp that sorts chronologically as a plain string", () => {
    const earlier = backupFilename(new Date("2026-09-11T03:00:00.000Z"));
    const later = backupFilename(new Date("2026-09-12T03:00:00.000Z"));

    assert.equal(earlier, "salawat-20260911T030000Z.db");
    assert.ok(earlier < later);
  });
});

describe("backupDatabase", () => {
  it("writes a real, openable SQLite copy", async () => {
    const dest = await backupDatabase();
    assert.ok(existsSync(dest));

    const Database = (await import("better-sqlite3")).default;
    const restored = new Database(dest, { readonly: true });
    try {
      // The schema is what a restore actually depends on being intact.
      const tables = restored
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[];
      assert.ok(tables.some((t) => t.name === "users"));
      assert.ok(tables.some((t) => t.name === "rooms"));
    } finally {
      restored.close();
    }
  });

  it("adds a new file instead of overwriting the previous backup", async () => {
    const first = await backupDatabase(new Date("2026-09-10T03:00:00.000Z"));
    const second = await backupDatabase(new Date("2026-09-11T03:00:00.000Z"));

    assert.notEqual(first, second);
    assert.ok(existsSync(first), "the earlier backup must survive the next one");
    assert.ok(existsSync(second));
  });

  it("does not clobber an existing file when two backups land in the same second", async () => {
    const stamp = new Date("2026-09-11T03:00:00.000Z");
    const first = await backupDatabase(stamp);
    const second = await backupDatabase(stamp);

    assert.notEqual(first, second);
    assert.ok(existsSync(first));
    assert.ok(existsSync(second));
  });

  it("keeps only the BACKUP_KEEP newest", async () => {
    for (let day = 1; day <= BACKUP_KEEP + 3; day++) {
      const stamp = new Date(Date.UTC(2026, 8, day, 3, 0, 0));
      await backupDatabase(stamp);
    }

    const remaining = readdirSync(getBackupDir());
    assert.equal(remaining.length, BACKUP_KEEP);
    // The oldest three are the ones that went.
    assert.ok(!remaining.includes("salawat-20260901T030000Z.db"));
    assert.ok(remaining.includes("salawat-20260910T030000Z.db"));
  });
});

describe("pruneBackups", () => {
  it("removes oldest-first and reports what it deleted", async () => {
    await backupDatabase(new Date("2026-09-01T03:00:00.000Z"));
    await backupDatabase(new Date("2026-09-02T03:00:00.000Z"));
    await backupDatabase(new Date("2026-09-03T03:00:00.000Z"));

    const removed = pruneBackups(1);
    assert.equal(removed.length, 2);
    assert.deepEqual(readdirSync(getBackupDir()), ["salawat-20260903T030000Z.db"]);
  });

  it("ignores files that are not rotated backups", async () => {
    await backupDatabase();
    writeFileSync(join(getBackupDir(), "notes.txt"), "keep me");

    pruneBackups(0);
    assert.deepEqual(readdirSync(getBackupDir()), ["notes.txt"]);
  });
});

describe("newestBackupAgeMs", () => {
  it("is null when nothing has been backed up yet", () => {
    assert.equal(newestBackupAgeMs(), null);
  });

  it("reports the age of the most recent backup, not the oldest", async () => {
    await backupDatabase();
    seedBackup("salawat-20200101T030000Z.db", 400 * 24 * 60 * 60 * 1000);

    const age = newestBackupAgeMs();
    assert.ok(age !== null && age < 60_000, `expected a fresh age, got ${age}`);
  });
});

describe("shouldRunStartupBackup", () => {
  const twelveHours = 12 * 60 * 60 * 1000;

  it("runs when there is no backup at all", () => {
    assert.equal(shouldRunStartupBackup(null, twelveHours), true);
  });

  it("runs once the newest backup has aged past the threshold", () => {
    assert.equal(shouldRunStartupBackup(twelveHours, twelveHours), true);
    assert.equal(shouldRunStartupBackup(twelveHours + 1, twelveHours), true);
  });

  /**
   * The crash-loop guard. A service restarting every few seconds must not push
   * BACKUP_KEEP copies of a broken state through the rotation and destroy the
   * history someone is about to restore from.
   */
  it("skips every restart in a crash loop", () => {
    for (let restartSeconds = 5; restartSeconds <= 300; restartSeconds += 5) {
      assert.equal(
        shouldRunStartupBackup(restartSeconds * 1000, twelveHours),
        false,
        `a restart ${restartSeconds}s after the last backup must not back up again`
      );
    }
  });
});

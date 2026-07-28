import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, stat, unlink, type FileHandle } from "node:fs/promises";
import * as path from "node:path";

const RETRY_DELAY_MS = 50;
const ACQUIRE_TIMEOUT_MS = 10_000;
const STALE_AFTER_MS = 30_000;

export class RootLock {
  constructor(private readonly directory: string) {}

  async run<T>(root: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lockPath = path.join(this.directory, `${createHash("sha256").update(root).digest("hex")}.lock`);
    const lock = await this.acquire(lockPath);
    try {
      return await operation();
    } finally {
      await this.release(lockPath, lock);
    }
  }

  private async acquire(lockPath: string): Promise<FileHandle> {
    const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
    while (true) {
      try {
        return await open(lockPath, "wx");
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }
      }
      await this.reclaimIfStale(lockPath);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Space creation lock: ${lockPath}`);
      }
      await delay(RETRY_DELAY_MS);
    }
  }

  private async reclaimIfStale(lockPath: string): Promise<void> {
    let lockStat;
    try {
      lockStat = await stat(lockPath);
    } catch {
      return;
    }
    if (Date.now() - lockStat.mtimeMs < STALE_AFTER_MS) {
      return;
    }
    const stalePath = `${lockPath}.stale-${randomUUID()}`;
    try {
      // A hard link captures the inode we inspected. Only unlink the public lock
      // name if it still points at that inode, so a concurrent reclaimer can
      // never remove a newly acquired successor lock.
      await link(lockPath, stalePath);
      const [current, captured] = await Promise.all([stat(lockPath), stat(stalePath)]);
      if (current.dev === captured.dev && current.ino === captured.ino) {
        await unlink(lockPath);
      }
    } catch {
      // Another Extension Host acquired or reclaimed the lock first.
    } finally {
      await unlink(stalePath).catch(() => undefined);
    }
  }

  private async release(lockPath: string, lock: FileHandle): Promise<void> {
    try {
      const [current, owned] = await Promise.all([stat(lockPath), lock.stat()]);
      if (current.dev === owned.dev && current.ino === owned.ino) {
        await unlink(lockPath);
      }
    } catch {
      // A stale-lock reclaimer may already have removed this lock.
    } finally {
      await lock.close();
    }
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

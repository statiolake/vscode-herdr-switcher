import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inferWorkspaceRoot } from "./model";
import type { HerdrSnapshot } from "./types";

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 10_000;

interface CachedBranch {
  branch: string | undefined;
  expiresAt: number;
}

/** Git presentation data is absent from session.snapshot, so derive and cache it by space root. */
export class GitBranchProvider {
  private readonly cache = new Map<string, CachedBranch>();

  async forSnapshot(snapshot: HerdrSnapshot): Promise<Map<string, string>> {
    const entries = await Promise.all(snapshot.workspaces.map(async (workspace) => {
      const root = inferWorkspaceRoot(snapshot, workspace);
      return [workspace.workspace_id, root ? await this.branchAt(root) : undefined] as const;
    }));
    return new Map(entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined));
  }

  private async branchAt(root: string): Promise<string | undefined> {
    const cached = this.cache.get(root);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.branch;
    }
    const branch = await gitOutput(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
      ?? await gitOutput(root, ["rev-parse", "--short", "HEAD"]);
    this.cache.set(root, { branch, expiresAt: Date.now() + CACHE_TTL_MS });
    return branch;
  }
}

async function gitOutput(root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

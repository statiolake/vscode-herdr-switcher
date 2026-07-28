import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { RootLock } from "./rootLock";

test("serializes operations for the same root", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "herdr-root-lock-"));
  try {
    const lock = new RootLock(directory);
    let active = 0;
    let maximumActive = 0;
    const operation = () => lock.run("/project", async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    });
    await Promise.all([operation(), operation(), operation()]);
    assert.equal(maximumActive, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not serialize different roots", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "herdr-root-lock-"));
  try {
    const lock = new RootLock(directory);
    let active = 0;
    let maximumActive = 0;
    const operation = (root: string) => lock.run(root, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    });
    await Promise.all([operation("/one"), operation("/two")]);
    assert.equal(maximumActive, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

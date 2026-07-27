import assert from "node:assert/strict";
import test from "node:test";
import { decodeDevContainerHostPath } from "./devContainer";

function authority(payload: string): string {
  return `dev-container+${Buffer.from(payload).toString("hex")}@ssh-remote+host`;
}

test("decodes a plain Dev Container host path", () => {
  assert.equal(decodeDevContainerHostPath(authority("/host/project")), "/host/project");
});

test("decodes a JSON Dev Container authority payload", () => {
  assert.equal(
    decodeDevContainerHostPath(authority(JSON.stringify({ hostPath: "/host/project", configFile: ".devcontainer/devcontainer.json" }))),
    "/host/project",
  );
});

test("rejects malformed Dev Container authorities", () => {
  assert.equal(decodeDevContainerHostPath("ssh-remote+host"), undefined);
  assert.equal(decodeDevContainerHostPath("dev-container+7b"), undefined);
});

import assert from "node:assert/strict";
import test from "node:test";
import { herdrRootForFolder } from "./workspaceRoot";

function hex(payload: string): string {
  return Buffer.from(payload).toString("hex");
}

test("uses the native path of a file folder", () => {
  assert.deepEqual(
    herdrRootForFolder({ scheme: "file", authority: "", fsPath: "/home/testuser/project" }),
    { kind: "root", root: "/home/testuser/project" },
  );
});

test("maps a Dev Container folder to its host path", () => {
  assert.deepEqual(
    herdrRootForFolder({ scheme: "vscode-remote", authority: `dev-container+${hex("/host/project")}`, fsPath: "/workspaces/project" }),
    { kind: "root", root: "/host/project" },
  );
});

test("reports a Dev Container nested inside another remote", () => {
  const result = herdrRootForFolder({
    scheme: "vscode-remote",
    authority: `dev-container+${hex("/home/testuser/project")}@ssh-remote+example-host`,
    fsPath: "/workspaces/project",
  });
  assert.equal(result.kind, "unsupported");
  assert.match(result.kind === "unsupported" ? result.detail : "", /another remote host.*remote\.extensionKind/);
});

test("reports an undecodable Dev Container folder", () => {
  const result = herdrRootForFolder({ scheme: "vscode-remote", authority: "dev-container+7b", fsPath: "/workspaces/project" });
  assert.equal(result.kind, "unsupported");
  assert.match(result.kind === "unsupported" ? result.detail : "", /Dev Container/);
});

test("reports an SSH folder seen from the UI host with guidance", () => {
  const result = herdrRootForFolder({ scheme: "vscode-remote", authority: "ssh-remote+example-host", fsPath: "/home/testuser/project" });
  assert.equal(result.kind, "unsupported");
  assert.match(result.kind === "unsupported" ? result.detail : "", /ssh-remote.*remote\.extensionKind/);
});

test("reports non-file, non-remote schemes", () => {
  const result = herdrRootForFolder({ scheme: "vsls", authority: "session", fsPath: "/project" });
  assert.equal(result.kind, "unsupported");
});

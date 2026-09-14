import { decodeDevContainerHostPath } from "./devContainer";

export interface FolderUri {
  scheme: string;
  authority: string;
  fsPath: string;
}

export type HerdrRootResult =
  | { kind: "root"; root: string }
  | { kind: "unsupported"; detail: string };

// Resolves the path Herdr sees for a workspace folder. Herdr runs on the same
// machine as this extension host, so a `file` URI is already native: that is
// a local window for the UI host, or the remote machine (e.g. Remote SSH) for
// the workspace host. A Dev Container window seen from the UI host maps back
// to its decoded host path.
export function herdrRootForFolder(uri: FolderUri): HerdrRootResult {
  if (uri.scheme === "file") {
    return { kind: "root", root: uri.fsPath };
  }
  if (uri.scheme !== "vscode-remote") {
    return { kind: "unsupported", detail: `URI scheme “${uri.scheme}” is not supported` };
  }
  if (uri.authority.startsWith("dev-container+")) {
    // A nested authority such as `dev-container+…@ssh-remote+host` carries a
    // host path on the SSH machine, not on the machine this extension runs on.
    if (uri.authority.includes("@")) {
      return {
        kind: "unsupported",
        detail: "the Dev Container runs on another remote host, so its host path is not on this machine; "
          + "run Herdr Switcher on the remote extension host instead (see “remote.extensionKind” in the README)",
      };
    }
    const root = decodeDevContainerHostPath(uri.authority);
    return root
      ? { kind: "root", root }
      : { kind: "unsupported", detail: "the local host path could not be decoded from the Dev Container URI" };
  }
  const remoteType = uri.authority.split("+", 1)[0] || "unknown";
  return {
    kind: "unsupported",
    detail: `remote type “${remoteType}” is not supported from the local UI extension host; `
      + "run Herdr Switcher on the remote extension host instead (see “remote.extensionKind” in the README)",
  };
}

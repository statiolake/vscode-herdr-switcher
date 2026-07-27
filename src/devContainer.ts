export function decodeDevContainerHostPath(authority: string): string | undefined {
  const match = /^dev-container\+([0-9a-fA-F]+)/.exec(authority);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(match[1], "hex").toString("utf8");
    if (!decoded.startsWith("{")) {
      return decoded || undefined;
    }
    const value = JSON.parse(decoded) as { hostPath?: unknown };
    return typeof value.hostPath === "string" && value.hostPath ? value.hostPath : undefined;
  } catch {
    return undefined;
  }
}

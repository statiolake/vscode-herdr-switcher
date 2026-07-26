export type AgentOutputPreview =
  | { kind: "loading" }
  | { kind: "output"; text: string }
  | { kind: "empty" }
  | { kind: "error" };

export function formatOutputPreview(text: string, maxLines = 12, maxCharacters = 1_600): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const preview = lines.slice(-maxLines).join("\n");
  return preview.length <= maxCharacters ? preview : `…${preview.slice(-(maxCharacters - 1))}`;
}

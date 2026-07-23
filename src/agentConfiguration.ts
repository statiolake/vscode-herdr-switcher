export interface ConfiguredAgent {
  name: string;
  command: string[];
}

export function configuredAgents(value: unknown): ConfiguredAgent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: ConfiguredAgent[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const { name, command } = candidate as { name?: unknown; command?: unknown };
    const normalizedName = typeof name === "string" ? name.trim() : "";
    if (!normalizedName || seen.has(normalizedName) || !Array.isArray(command)) {
      continue;
    }
    const normalizedCommand = command.every((part) => typeof part === "string" && part.length > 0)
      ? command as string[]
      : [];
    if (normalizedCommand.length === 0) {
      continue;
    }
    seen.add(normalizedName);
    result.push({ name: normalizedName, command: [...normalizedCommand] });
  }
  return result;
}

export function shellCommand(argv: readonly string[], platform = process.platform): string {
  const quote = platform === "win32" ? quotePowerShell : quotePosix;
  return argv.map(quote).join(" ");
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

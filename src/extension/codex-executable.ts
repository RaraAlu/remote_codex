import { homedir } from "node:os";
import { join } from "node:path";

export function codexExecutableCandidates(
  configured: string,
  homeDirectory = homedir(),
): string[] {
  if (configured !== "codex") {
    return [configured];
  }
  return [
    configured,
    join(homeDirectory, ".local", "bin", "codex"),
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ];
}

import { homedir } from "node:os";
import { normalize, parse, resolve } from "node:path";
import { FULL_LOCAL_ACCESS_ROOT_ID } from "../core/full-local-access.js";
import type { WorkspaceRootConfig } from "../core/types.js";

export function fullLocalAccessRoot(): WorkspaceRootConfig {
  const path = normalize(parse(resolve(homedir())).root);
  return {
    id: FULL_LOCAL_ACCESS_ROOT_ID,
    target: "local",
    role: "secondary",
    path,
    displayName: "Local filesystem",
  };
}

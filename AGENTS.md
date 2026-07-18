# Project Working Rules

## Workflow

- Read the relevant implementation and tests before changing behavior.
- Keep fixes scoped to one verified problem at a time.
- After a fix passes its relevant tests, create an intentional Git commit for that fix instead of accumulating unrelated changes.
- Use Chinese commit subjects and bodies. Include the behavioral change and verification performed; do not add signatures or sign-offs.
- Do not push a fix until its real VS Code/Remote SSH behavior has been verified when the change affects that integration.

## Remote SSH Safety

- The user performs Remote SSH connection, password entry, and window reload steps manually, then reports when the window is connected.
- Reuse the active VS Code Remote SSH transport by default. Do not start a second SSH authentication flow unless the user explicitly selects the OpenSSH fallback.
- Never store, log, repeat, or commit passwords, private keys, tokens, or session transport tokens.
- Do not rewrite, replace, or synthesize the VS Code workspace folder URI to satisfy Codex UI validation. It can break normal workspace loading.
- Keep the canonical remote workspace root as a POSIX absolute path and validate it against the open Remote SSH workspace.

## Compatibility

- Treat the official `openai.chatgpt` extension, Codex CLI/app-server protocol, Bridge Controller, and Remote Executor as a compatibility set.
- The currently verified official extension is `openai.chatgpt@26.707.91948` with `codex-cli 0.144.5`.
- Newer official extension versions must be tested for task-creation behavior before being declared supported; `26.715.31925` rejects the Windows UI representation of a Remote SSH root as `Unknown local project`.
- In `vscode-remote` mode, do not claim that a workspace MCP is remotely routed unless it is actually bridged through the VS Code transport. The legacy SSH stdio MCP route only applies to `openssh` mode.

## Verification

- Run targeted tests while iterating, then `npm run check` before packaging a release candidate.
- For integration fixes, verify the installed VSIX in a real Remote SSH window and inspect both the Codex log and Bridge audit log.
- Confirm that task creation reaches the shim and that project operations are recorded as remote operations before committing the integration fix.

## Generated Artifacts

- Do not use `dist/` as an archive. Remove historical versioned VSIX files and keep only the latest Controller packages for both `win32-x64` and `linux-x64`, the latest versioned Remote Executor package, and the current unversioned build outputs required for packaging.
- Derive the retained Controller version from the root `package.json` and the retained Executor version from `remote-executor/package.json`; do not delete the matching current artifacts.
- After cleanup or packaging, verify that both current-platform Controller VSIX files, the matching versioned Executor VSIX, and `codex-remote-bridge-executor.vsix` remain in `dist/`.

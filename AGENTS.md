# Project Working Rules

## Workflow

- Read the relevant implementation and tests before changing behavior.
- Keep fixes scoped to one verified problem at a time.
- After a fix passes its relevant tests, create an intentional Git commit for that fix instead of accumulating unrelated changes.
- Use Chinese commit subjects and bodies. Include the behavioral change and verification performed; do not add signatures or sign-offs.
- Do not push a fix until its real VS Code/Remote SSH behavior has been verified when the change affects that integration.
- Version updates in the current `0.x` development series follow implementation scope rather than
  generic stable-SemVer feature labels. Complete one independently verifiable implementation
  target before incrementing the third segment (`0.x.1 -> 0.x.2`); complete a coherent batch of
  targets before incrementing the second segment (`0.1.x -> 0.2.x`). Do not bump once per edit or
  before the target is implemented. Update the matching lockfile and release evidence in the same
  target commit, and never publish changed behavior under a previously used version. Bump
  `remote-executor/package.json` only when the Remote Executor implementation or its protocol
  changes; Controller/Shim-only targets bump the root package.

## Remote SSH Safety

- The user performs Remote SSH connection, password entry, and window reload steps manually, then reports when the window is connected.
- Reuse the active VS Code Remote SSH transport by default. Do not start a second SSH authentication flow unless the user explicitly selects the OpenSSH fallback.
- Never store, log, repeat, or commit passwords, private keys, tokens, or session transport tokens.
- Do not rewrite, replace, or synthesize the VS Code workspace folder URI to satisfy Codex UI validation. It can break normal workspace loading.
- Keep the canonical remote workspace root as a POSIX absolute path and validate it against the open Remote SSH workspace.

## Compatibility

- Treat the official `openai.chatgpt` extension, Codex CLI/app-server protocol, Bridge Controller, and Remote Executor as a compatibility set.
- Component, package, extension, CLI, app-server, and Executor protocol version values are
  diagnostic evidence and regression-test triggers only. Never use one of those version values,
  version equality, or a missing diagnostic version as a runtime admission gate. Gate only on the
  actual executable, required capability set, message shape, or a failed operation. A serialized
  format's schema discriminator may select its parser, but rejection must be grounded in an
  unsupported message shape. Enter `incompatible` only after a concrete capability or protocol
  behavior fails.
- Record observed official extension and bundled Codex versions in dated acceptance evidence; do
  not designate an exact pair as a permanent required version. The latest Linux Remote SSH
  evidence is recorded in `docs/acceptance/2026-07-23-release-0.3.3-remote-cli-acceptance.md`;
  Windows keeps its own last fully verified baseline until rerun.
- Newer official extension versions must be tested for task-creation behavior before being declared supported; `26.715.31925` rejects the Windows UI representation of a Remote SSH root as `Unknown local project`.
- In `vscode-remote` mode, do not claim that a workspace MCP is remotely routed unless it is actually bridged through the VS Code transport. The legacy SSH stdio MCP route only applies to `openssh` mode.
- Use `docs/upgrade-tracking.md` as the release gate whenever any compatibility-set component, VS Code, Remote SSH, OpenSSH, MCP routing, or a supported local platform changes. Create or update a dated release record from `docs/acceptance/release-template.md` instead of overwriting old evidence.

## Verification

- Run targeted tests while iterating, then `npm run check` before packaging a release candidate.
- For integration fixes, verify the installed VSIX in a real Remote SSH window and inspect both the Codex log and Bridge audit log.
- Confirm that task creation reaches the shim and that project operations are recorded as remote operations before committing the integration fix.
- Record Windows x64 and Linux x64 separately. Cross-packaging a VSIX proves artifact construction and content isolation only; it does not prove the other platform's Extension Host, Shim, official task, or Remote SSH runtime path.
- Record the hard gates and quantitative metrics defined in `docs/upgrade-tracking.md`. Mark missing evidence as `待补测`; never turn an unmeasured value into zero or copy a prior release result without rerunning the triggered chain.

## Generated Artifacts

- Do not use `dist/` as an archive. Remove historical versioned VSIX files and keep only the latest Controller packages for both `win32-x64` and `linux-x64`, the latest versioned Remote Executor package, and the current unversioned build outputs required for packaging.
- Derive the retained Controller version from the root `package.json` and the retained Executor version from `remote-executor/package.json`; do not delete the matching current artifacts.
- After cleanup or packaging, verify that both current-platform Controller VSIX files, the matching versioned Executor VSIX, and `codex-remote-bridge-executor.vsix` remain in `dist/`.

# Codex Remote Bridge Executor

This is the remote workspace component of Codex Remote Bridge. It runs inside the VS Code
Remote Extension Host and executes structured workspace operations over the existing VS Code
Remote SSH connection. It does not contain Codex, OpenAI credentials, or network routing code.

Install this VSIX on the Remote SSH target and install the matching Codex Remote Bridge controller
VSIX locally.

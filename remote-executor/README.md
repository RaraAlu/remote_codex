# Codex Remote Bridge Executor

This is the remote workspace component of Codex Remote Bridge. It runs inside the VS Code
Remote Extension Host and executes structured workspace operations over the existing VS Code
Remote SSH connection. It does not contain Codex, OpenAI credentials, or network routing code.
It also owns bounded, long-lived stdio sessions for eligible credential-free MCP executables. The
controller forwards those byte streams over the same authenticated VS Code Remote connection and
terminates the child process when the relay or window closes.

Install this VSIX on the Remote SSH target and install the matching Codex Remote Bridge controller
VSIX locally.

# Project conventions
- Keep extensions self-contained by module directory; each package has its own manifest and commonly its own tests/tsconfig.
- Favor strict TypeScript and explicit error handling around subprocesses, filesystem operations, and LSP lifecycle; preserve async cleanup and abort behavior.
- LSP supports multiple server backends and manages clients per project root; changes must consider initialization timeout, diagnostics readiness, idle cleanup, crash/exit handling, and orphan processes.
- Permission decisions are security-sensitive: command parsing/classification must fail closed and account for shell expansion/redirection/xargs rather than relying only on the first command token.
- Checkpoint path/argument handling is security-sensitive; preserve Git path boundaries and avoid ambiguous argument interpretation.
- Root README is the user-facing source for install/configure/test instructions; keep filenames and exported extension paths synchronized with manifests.
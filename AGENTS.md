# AGENTS.md

`fs-safe` is a filesystem-safety library for Node.js apps handling untrusted
relative paths. Treat boundary behavior as security-sensitive.

## Rules

- Do not weaken path, symlink, archive, permission, or secret-file boundaries.
- Add focused tests for traversal, archive extraction, root confinement, and
  write/read boundary changes.
- Keep package exports and docs aligned when adding public APIs.
- Do not commit generated `dist/`; build output is package-only.

## Checks

```bash
pnpm build
pnpm test
pnpm test:security
pnpm check
git diff --check
```

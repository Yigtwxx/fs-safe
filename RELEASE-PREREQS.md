# 0.5.0 release prerequisites

Complete this checklist in npm before pushing the first `v0.5.0` tag. The release workflow uses npm trusted publishing and has no npm token fallback.

## Package setup

Create or confirm these public packages under the `@openclaw` scope:

- `@openclaw/fs-safe-native-linux-x64-gnu`
- `@openclaw/fs-safe-native-linux-x64-musl`
- `@openclaw/fs-safe-native-linux-arm64-gnu`
- `@openclaw/fs-safe-native-linux-arm64-musl`
- `@openclaw/fs-safe-native-darwin-x64`
- `@openclaw/fs-safe-native-darwin-arm64`
- `@openclaw/fs-safe-native-win32-x64-msvc`
- `@openclaw/fs-safe-native`
- `@openclaw/fs-safe`

For every package above, open npm package settings and configure the same trusted publisher:

| npm trusted-publisher field | Required value |
|---|---|
| Provider | GitHub Actions |
| Organization or user | `openclaw` |
| Repository | `fs-safe` |
| Workflow filename | `release.yml` |
| Environment | Leave empty; this workflow does not use a GitHub environment. |

Confirm each package is public, the OpenClaw npm organization owns it, and the publishing maintainers have 2FA enabled. Do not add `NPM_TOKEN` or an automation token to GitHub.

## Release commit and tag

- Replace `0.5.0-dev.0` with `0.5.0` in the root, native loader, Rust crate, all seven platform package manifests, and generated native loader version checks.
- Run `pnpm install` so `pnpm-lock.yaml` matches the stable package versions.
- Change `## 0.5.0 - Unreleased` in `CHANGELOG.md` to the release date.
- Run `pnpm check`, `pnpm test:security`, `cargo test --workspace --locked`, `pnpm docs:site`, and `git diff --check` on the release commit.
- Merge the release commit to `main`, then create an annotated, protected `v0.5.0` tag on that exact commit.

The workflow validates the protected annotated tag, `main` ancestry, all nine package versions, package bytes, install/import behavior, and changelog-derived release notes before it publishes anything.

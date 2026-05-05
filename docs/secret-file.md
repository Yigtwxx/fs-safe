# Secret files

Helpers for reading and writing credentials. Files are written at mode `0o600`, dirs at `0o700`, with a maximum read size to avoid OOM on bogus input.

```ts
import {
  loadSecretFileSync,
  readSecretFileSync,
  tryReadSecretFileSync,
  writePrivateSecretFileAtomic,
  DEFAULT_SECRET_FILE_MAX_BYTES,
  PRIVATE_SECRET_DIR_MODE,
  PRIVATE_SECRET_FILE_MODE,
} from "@openclaw/fs-safe";
```

## When to use these vs `writeJson`

| Use these when | Use `writeJson` when |
|---|---|
| The file is a credential (token, key, password). | The file is application state. |
| You want the parent directory created at `0o700` if missing. | You don't care about the parent directory mode. |
| You want a hard size cap on reads (to defend against bogus input). | You're reading bounded JSON state. |
| Mode `0o600` is mandatory, not just nice. | Mode is whatever umask gives you. |

## Constants

```ts
DEFAULT_SECRET_FILE_MAX_BYTES = 16 * 1024;  // 16 KiB
PRIVATE_SECRET_DIR_MODE = 0o700;
PRIVATE_SECRET_FILE_MODE = 0o600;
```

The 16 KiB cap is intentionally aggressive — credentials should be small. If you need bigger, pass `maxBytes` explicitly.

## Reading

### `tryReadSecretFileSync(filePath, options?)`

The lenient reader. Returns a `SecretFileReadResult`:

```ts
type SecretFileReadResult =
  | { ok: true; content: string }
  | { ok: false; reason: "missing" | "too-large" | "invalid-mode" | "io-error"; cause?: unknown };
```

```ts
import { tryReadSecretFileSync } from "@openclaw/fs-safe";

const r = tryReadSecretFileSync("/var/lib/app/auth.token");
if (r.ok) {
  useToken(r.content);
} else if (r.reason === "missing") {
  await reauthenticate();
} else if (r.reason === "invalid-mode") {
  console.warn("auth.token has unsafe permissions; refusing to read");
}
```

### `readSecretFileSync(filePath, options?)`

Strict reader. Throws `FsSafeError` on missing/too-large/invalid-mode/io-error. Use when failing loudly is the right call:

```ts
const token = readSecretFileSync("/var/lib/app/auth.token");
```

### `loadSecretFileSync(filePath, options?)`

Like `tryReadSecretFileSync` but returns the raw `SecretFileReadResult` for callers that want full access to the failure shape (e.g. wiring into a richer error type).

### Read options

```ts
type SecretFileReadOptions = {
  maxBytes?: number;         // default DEFAULT_SECRET_FILE_MAX_BYTES (16 KiB)
  encoding?: BufferEncoding; // default "utf8"
};
```

The reader checks the file's mode bits before reading. If `nlink > 1` (the file is a hardlink alias) or mode is wider than `0o600` for the owner-rw bits beyond what's expected, the reader returns `"invalid-mode"`. Treat that as a clear signal: the secret file's permissions are wrong, fix them at the source rather than swallowing the warning.

## Writing

### `writePrivateSecretFileAtomic(params)`

Async. Creates the parent directory at `dirMode` (default `0o700`) if missing, writes content to a sibling temp file at `mode` (default `0o600`), atomically renames over the destination, and re-asserts the file mode after rename.

```ts
import { writePrivateSecretFileAtomic } from "@openclaw/fs-safe";

await writePrivateSecretFileAtomic({
  rootDir: "/var/lib/app",
  filePath: "/var/lib/app/auth.token",
  content: token,
});
```

### Parameters

```ts
type WritePrivateSecretFileParams = {
  rootDir: string;             // trusted root directory (created at dirMode if missing)
  filePath: string;             // absolute path; must be inside rootDir
  content: string | Uint8Array;
  mode?: number;                // file mode for the new file (default PRIVATE_SECRET_FILE_MODE = 0o600)
  dirMode?: number;             // mode for the root and intermediate dirs (default PRIVATE_SECRET_DIR_MODE = 0o700)
};
```

The directory mode is asserted on each component along the path: `rootDir`, then any intermediate dirs, then the parent. The helper enforces that every component matches `dirMode` — wider permissions on an existing directory cause the write to fail. Audit and tighten existing secret directories yourself.

For more permissive credentials, override `mode`:

```ts
await writePrivateSecretFileAtomic({
  rootDir: "/var/lib/app",
  filePath: "/var/lib/app/readonly.token",
  content: token,
  mode: 0o400, // tighter than the default
});
```

## Common patterns

### Load on boot, reauthenticate on miss

```ts
const r = tryReadSecretFileSync("/var/lib/app/auth.token");
if (!r.ok) {
  if (r.reason === "missing") {
    await runOauthFlow();
  } else if (r.reason === "invalid-mode") {
    throw new Error("token file has unsafe permissions; aborting");
  } else {
    throw new Error(`failed to load token: ${r.reason}`, { cause: r.cause });
  }
}
```

### Refresh and persist a token

```ts
const fresh = await refreshToken(currentRefresh);
await writePrivateSecretFileAtomic({
  rootDir: "/var/lib/app",
  filePath: "/var/lib/app/auth.token",
  content: JSON.stringify(fresh),
});
```

### Compose with `withTimeout`

```ts
import { withTimeout } from "@openclaw/fs-safe/timing";

await withTimeout(
  writePrivateSecretFileAtomic({ rootDir, filePath, content }),
  5_000,
  "persist auth token",
);
```

## Threat model notes

- These helpers protect the secret file from **other processes with the same UID** that respect filesystem permissions. They do not defend against root or against attackers who can read process memory.
- The `invalid-mode` failure reason is a tripwire, not authorization. It tells you the file's permissions are wrong — investigate before clearing.
- If the destination directory is on a tmpfs that does not honor mode bits, the helpers will set the mode bits but the OS may ignore them. Audit your platform.

## See also

- [JSON files](json.md) — `writeJson` accepts `mode: 0o600` for non-secret JSON state.
- [Atomic writes](atomic.md) — the lower-level `replaceFileAtomic` used by these helpers.
- [Private file store](private-file-store.md) — root-bounded JSON+text helpers without secret-file mode policy.

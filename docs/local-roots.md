# Local roots

`local-roots` is a small set of helpers for code that holds a list of trusted base directories ("roots") and wants to look up an absolute path or a relative-to-some-root reference against any of them.

The shape covers two needs:

- "Resolve this path string to an absolute path that lives inside one of the configured roots, or refuse it."
- "Read this path, where it could be `/abs/path`, `~/relative`, `file://…`, or simply the basename of a file in one of my roots."

```ts
import {
  readLocalFileFromRoots,
  resolveLocalPathFromRootsSync,
} from "@openclaw/fs-safe/advanced";
```

## Shape of a "roots input"

Both helpers take roots as either an array of strings or a `LocalRootsInputOptions` record. Each root is an absolute path the caller already trusts:

```ts
type LocalRootsInputOptions = {
  roots: string[];                    // absolute paths
  allowAbsolute?: boolean;            // accept absolute inputs (default true)
  allowFileUrls?: boolean;            // accept file:// URLs (default true)
  expandHome?: boolean;               // expand ~ in inputs (default true)
};
```

If a root is a symlink, it is canonicalized at lookup time. The helpers work in the order roots are listed: the first root that contains the resolved path wins.

## `resolveLocalPathFromRootsSync(input, options)`

Synchronous resolution. Returns:

```ts
type LocalRootsPathResult =
  | { ok: true; absolutePath: string; rootDir: string; relativePath: string }
  | { ok: false; reason: "outside-roots" | "invalid-input" };
```

```ts
import { resolveLocalPathFromRootsSync } from "@openclaw/fs-safe/advanced";

const r = resolveLocalPathFromRootsSync("photo.jpg", {
  roots: ["/srv/uploads", "/srv/cache"],
});

if (!r.ok) return reply(400, r.reason);
console.log(r.absolutePath);  // /srv/uploads/photo.jpg (assuming it's there)
console.log(r.rootDir);       // /srv/uploads
console.log(r.relativePath);  // photo.jpg
```

### Resolution order

For each candidate input:

1. If the input is a `file://` URL and `allowFileUrls` is true, decode to an absolute path.
2. If the input begins with `~/` and `expandHome` is true, expand to the user's home dir.
3. If the input is absolute (`/...` or Windows drive) and `allowAbsolute` is true, accept it as-is and check it falls under one of the roots.
4. Otherwise, treat the input as relative and resolve it against each root in order until one contains the resulting path.

If no root contains the result, returns `{ ok: false, reason: "outside-roots" }`.

`"invalid-input"` covers empty strings, embedded NULs, encoded `..` traversal, Windows network paths (`\\server\share`), and other constructs that should not be resolved at all.

## `readLocalFileFromRoots(input, options)`

Async. Resolves through the same logic, then reads the file via [`Root`](root.md) so the read benefits from boundary checks, `O_NOFOLLOW`, and fd identity verification.

```ts
type LocalRootsReadResult = ReadResult & {
  rootDir: string;
  relativePath: string;
};

const r = await readLocalFileFromRoots("photo.jpg", {
  roots: ["/srv/uploads", "/srv/cache"],
  maxBytes: 8 * 1024 * 1024,
});
if (!r) return reply(404);
process.stdout.write(r.buffer);
```

The result extends `ReadResult` (`{ buffer, realPath, stat }`) with the matched `rootDir` and the path relative to it. Returns `null` if the input doesn't resolve into any root or the file is missing.

### Read options

```ts
type ReadLocalFileFromRootsOptions = LocalRootsInputOptions & {
  hardlinks?: "reject" | "allow";
  maxBytes?: number;
  symlinks?: "reject" | "follow-within-root";
};
```

The read-side options are forwarded to `Root` for the actual read.

## `local-file-access` companions

The `local-file-access` module (re-exported from `@openclaw/fs-safe/advanced`) supplies a few small helpers for input normalization that the roots helpers use under the hood. They are also useful on their own:

```ts
import {
  assertNoWindowsNetworkPath,
  basenameFromMediaSource,
  hasEncodedFileUrlSeparator,
  isWindowsDriveLetterPath,
  isWindowsNetworkPath,
  safeFileURLToPath,
  trySafeFileURLToPath,
} from "@openclaw/fs-safe/advanced";
```

- `safeFileURLToPath(fileUrl)` — `url.fileURLToPath` with explicit error throwing. Refuses URLs that decode to network paths.
- `trySafeFileURLToPath(fileUrl)` — same, returns `undefined` instead of throwing.
- `isWindowsDriveLetterPath(p, platform?)` — true for `C:\...` style absolute paths when the platform is Windows.
- `isWindowsNetworkPath(p, platform?)` — true for `\\server\share` and `//server/share` style paths when the platform is Windows.
- `assertNoWindowsNetworkPath(p, label?)` — throws if it is.
- `basenameFromMediaSource(source?)` — best-effort filename extraction from URLs / data URIs / paths, for naming downloaded media.
- `hasEncodedFileUrlSeparator(pathname)` — true for paths containing percent-encoded `/` (`%2F` / `%5C`), which often indicate traversal attempts.

## Common patterns

### Multi-root config: search project, then user, then system

```ts
const text = await readLocalFileFromRoots(name, {
  roots: [path.join(projectDir, "templates"), path.join(homedir(), ".app/templates"), "/etc/app/templates"],
  allowAbsolute: false,  // only resolve names, never absolute paths
  maxBytes: 256 * 1024,
});
```

### Validate a file:// URL at the API boundary

```ts
import { safeFileURLToPath, isWindowsNetworkPath } from "@openclaw/fs-safe/advanced";

let abs: string;
try {
  abs = safeFileURLToPath(req.body.fileUrl);
} catch {
  return reply(400, "invalid file URL");
}
if (isWindowsNetworkPath(abs)) return reply(400, "network paths not allowed");
```

### Deny absolute, allow relative-only

```ts
const r = resolveLocalPathFromRootsSync(input, {
  roots: ["/srv/workspace"],
  allowAbsolute: false,
  allowFileUrls: false,
});
```

## See also

- [`root()`](root.md) — single-root variant of this multi-root setup.
- [Path helpers](path.md) — `isPathInside`, `safeRealpathSync` for ad-hoc checks.
- [`pathScope()`](path-scope.md) — single-root with `Result`-style returns.

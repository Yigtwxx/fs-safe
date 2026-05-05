# Regular file helpers

The advanced `regular-file` helpers provide direct read/append/stat helpers for absolute file paths, with an explicit "regular file or nothing" contract. Useful when you have a trusted absolute path and want a thin layer on top of `fs` that:

- refuses non-regular files (directories, FIFOs, sockets, symlinks)
- enforces a `maxBytes` read cap
- separates "missing" from "io-error" in the result type

```ts
import {
  readRegularFile,
  readRegularFileSync,
  appendRegularFile,
  appendRegularFileSync,
  resolveRegularFileAppendFlags,
  statRegularFile,
  statRegularFileSync,
  type AppendRegularFileOptions,
  type RegularFileStatResult,
} from "@openclaw/fs-safe/advanced";
```

## Stat

### `statRegularFile(filePath)`

Async. Returns:

```ts
type RegularFileStatResult =
  | { missing: true }
  | { missing: false; stat: Stats };
```

A non-regular file (directory, FIFO, …) returns `{ missing: false }` with a `stat` whose `isFile()` is false — the helper does not throw, you decide what to do.

```ts
import { statRegularFile } from "@openclaw/fs-safe/advanced";

const r = await statRegularFile("/var/log/app.log");
if (r.missing) return;
if (!r.stat.isFile()) throw new Error("expected a regular file");
console.log(`size=${r.stat.size}`);
```

### `statRegularFileSync(filePath)`

Synchronous variant. Same shape.

## Read

### `readRegularFile(params)`

Async. Reads the entire file into a Buffer if it is a regular file, with `maxBytes` enforcement.

```ts
import { readRegularFile } from "@openclaw/fs-safe/advanced";

const result = await readRegularFile({
  filePath: "/var/log/app.log",
  maxBytes: 4 * 1024 * 1024,
});
if (result.missing) return null;
if (!result.regular) throw new Error("not a regular file");
processLog(result.buffer);
```

Result shape:

```ts
type Result =
  | { missing: true }
  | { missing: false; regular: false; stat: Stats }
  | { missing: false; regular: true; stat: Stats; buffer: Buffer };
```

Throws `FsSafeError` with code `too-large` if the file exceeds `maxBytes`. Other I/O errors propagate as `NodeJS.ErrnoException`.

### `readRegularFileSync(params)`

Synchronous variant. Same shape; the only required field is `filePath`. `maxBytes` is optional.

## Append

### `appendRegularFile(options)`

Async. Opens the file in append mode, writes data, closes. Refuses non-regular targets:

```ts
import { appendRegularFile } from "@openclaw/fs-safe/advanced";

await appendRegularFile({
  filePath: "/var/log/app.log",
  data: `[${new Date().toISOString()}] ${line}\n`,
  encoding: "utf8",
  prependNewlineIfNeeded: true,
});
```

### Options

```ts
type AppendRegularFileOptions = {
  filePath: string;
  data: string | Buffer;
  encoding?: BufferEncoding;             // default utf8 when data is string
  prependNewlineIfNeeded?: boolean;      // insert "\n" if file does not end with one
  flags?: number;                         // raw open flags; default O_WRONLY | O_APPEND
  mode?: number;                          // default 0o644 if file is created
};
```

`prependNewlineIfNeeded` reads the trailing byte of the existing file and prepends a `\n` to your data if it isn't already present. Useful for log appenders that want to preserve line boundaries even when callers forget the newline.

### `appendRegularFileSync(options)`

Synchronous. Same options.

### `resolveRegularFileAppendFlags(append, truncateExisting)`

Helper that returns the right open-flag bitmask for combinations of "append" / "truncate". Use it when you're building your own open path and want to match the append helpers' behavior:

```ts
import { resolveRegularFileAppendFlags } from "@openclaw/fs-safe/advanced";

const flags = resolveRegularFileAppendFlags(true, false); // O_WRONLY | O_APPEND | O_CREAT
```

## Difference from `Root` methods

| `regular-file` | `Root` |
|---|---|
| Absolute paths only. | Relative to the root. |
| No identity check post-open. | Identity check on every read/write. |
| Caller must be confident the path is trusted. | Boundary check is automatic. |
| Returns explicit `{missing, regular}` shape. | Throws `FsSafeError` with `code`. |

If your call site already trusts the path (it came from your own config, not a caller), `regular-file` is a thinner, faster surface. If the path is caller-influenced, prefer `root()` or wrap in [`pathScope()`](path-scope.md).

## Common patterns

### Read a config file if it's there, else seed

```ts
const r = await readRegularFile({ filePath: "/etc/app/config.json", maxBytes: 64 * 1024 });
if (r.missing) {
  await writeJson("/etc/app/config.json", defaultConfig);
} else if (r.regular) {
  applyConfig(JSON.parse(r.buffer.toString("utf8")));
} else {
  throw new Error("/etc/app/config.json is not a regular file");
}
```

### Cheap "exists and is a file" check

```ts
const r = await statRegularFile(p);
if (r.missing || !r.stat.isFile()) return false;
return true;
```

### Bounded log tail

```ts
const r = await readRegularFile({ filePath: logPath, maxBytes: 1 * 1024 * 1024 });
if (r.missing || !r.regular) return [];
return r.buffer.toString("utf8").split("\n").slice(-100);
```

## See also

- [Reading](reading.md) — `Root` reads with boundary checks.
- [Atomic writes](atomic.md) — for atomic write semantics, prefer `replaceFileAtomic`.
- [`fs.appendFile`](https://nodejs.org/api/fs.html#fsappendfilepath-data-options-callback) — Node's stock append, without regular-file gating.

# Private file-store mode

Private state is not a separate store family. Use `fileStore({ private: true })`
when a directory holds credentials, tokens, auth profiles, or other private
JSON/text state.

```ts
import { fileStore } from "@openclaw/fs-safe/store";

const store = fileStore({ rootDir: "/var/lib/app", private: true });

await store.writeJson("state.json", state);
const loaded = await store.readJsonIfExists<State>("state.json");
```

## Behavior

- Writes create parent directories at `0o700` and files at `0o600` unless you
  pass stricter `dirMode` / `mode` options.
- Private-mode writes route through the secret-file atomic path, which refuses
  symlink parent components and re-asserts mode after rename.
- `readText()` and `readJson()` are strict and throw on missing files.
- `readTextIfExists()` and `readJsonIfExists()` return `null` on missing files.
- `write()`, `writeText()`, `writeJson()`, `writeStream()`, and `copyIn()` all
  keep the same root-relative `FileStore` shape.

## Sync writes

Use `fileStoreSync({ private: true })` for boot paths or sync-only integration
points:

```ts
import { fileStoreSync } from "@openclaw/fs-safe/store";

fileStoreSync({ rootDir: "/var/lib/app", private: true }).writeJson("config.json", config);
```

The sync store intentionally exposes a smaller surface: path resolution,
lenient reads, and atomic text/JSON writes.

## See also

- [`fileStore`](file-store.md) — full store API.
- [Secret files](secret-file.md) — standalone credential file reads and writes.
- [JSON files](json.md) — strict/lenient JSON helpers without a bound store.

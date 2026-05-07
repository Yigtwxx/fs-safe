# External outputs

`@openclaw/fs-safe/output` covers the case where another library insists on
writing to an absolute path you give it. Browser downloads, renderers, media
tools, and native libraries often have this shape:

```ts
import { writeExternalFileWithinRoot } from "@openclaw/fs-safe/output";

await writeExternalFileWithinRoot({
  rootDir: "/srv/workspace/downloads",
  path: "reports/today.pdf",
  write: async (filePath) => {
    await download.saveAs(filePath);
  },
});
```

The external writer never receives the final destination path. It receives a
private temp file path instead. After the callback returns, fs-safe copies that
staged file into the requested target through the same root boundary used by
`Root.copyIn()`.

## Signature

```ts
function writeExternalFileWithinRoot<T = void>(
  options: ExternalFileWriteOptions<T>,
): Promise<ExternalFileWriteResult<T>>;

type ExternalFileWriteOptions<T = void> = {
  rootDir: string;
  path: string; // relative or absolute, but must stay under rootDir
  write: (filePath: string) => Promise<T>;
  maxBytes?: number;
  mode?: number;
};

type ExternalFileWriteResult<T = void> = {
  path: string; // final absolute path under the canonical root
  result: T;    // value returned by write()
};
```

The requested `path` must name a file. Missing destination parents are created
by the helper because the operation is "produce this output file under the
root"; callers should choose the filename before calling this API.

Use `maxBytes` when the external producer can create arbitrarily large files.
Use `mode` when the finalized file needs a specific POSIX mode. Both are
enforced during the `Root.copyIn()` finalization step, after the external writer
has produced the staged file and before the final target is committed.

## Why not pass the final path to the library?

If a target parent can be swapped after validation, handing an external library
the final path can make the library write outside the intended root before
fs-safe has a chance to finalize or reject the operation. This helper stages in
a private temp workspace first, then finalizes with `Root.copyIn()`. That keeps
the trust-boundary write inside fs-safe's root-aware copy/atomic-write path.

## Browser download example

```ts
const outputPath = requestedOutputPath || sanitizeBrowserSuggestedName(suggestedFilename);

await writeExternalFileWithinRoot({
  rootDir: downloadsRoot,
  path: outputPath,
  maxBytes: 512 * 1024 * 1024,
  write: async (filePath) => {
    await download.saveAs(filePath);
  },
});
```

The chosen path may be absolute if it is already inside `downloadsRoot`, or
relative to `downloadsRoot`. Traversal, symlink parent escapes, hardlinked final
targets, over-large staged files, and missing temp files surface as
`FsSafeError`s.

This helper is not the right fit when the final filename depends on inspecting
the produced bytes. In that case, write to a private temp workspace, sniff or
validate the file, choose the final name, then copy or write into the root with
the normal root APIs.

## See also

- [Root writes](writing.md) — `write`, `copyIn`, `move`, and `mkdir`.
- [Temp workspaces](temp.md) — private scratch directories for longer workflows.
- [`pathScope()`](path-scope.md) — validation-only helper when you must pass an
  absolute path directly to another library.

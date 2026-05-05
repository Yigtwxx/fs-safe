import { spawn } from "node:child_process";
import fsSync from "node:fs";

import { FsSafeError } from "./errors.js";
import { splitSafeRelativePath } from "./path.js";
import type { SafeDirEntry, SafePathStat } from "./types.js";

const PINNED_HELPER_SOURCE = String.raw`
import base64
import errno
import json
import os
import stat
import sys
import tempfile

operation = sys.argv[1]
root_path = sys.argv[2]
payload = json.loads(sys.stdin.read() or "{}")

DIR_FLAGS = os.O_RDONLY
if hasattr(os, "O_DIRECTORY"):
    DIR_FLAGS |= os.O_DIRECTORY
if hasattr(os, "O_NOFOLLOW"):
    DIR_FLAGS |= os.O_NOFOLLOW
READ_FLAGS = os.O_RDONLY
if hasattr(os, "O_NOFOLLOW"):
    READ_FLAGS |= os.O_NOFOLLOW
WRITE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL
if hasattr(os, "O_NOFOLLOW"):
    WRITE_FLAGS |= os.O_NOFOLLOW

def fail(code, message):
    print(json.dumps({"ok": False, "code": code, "message": message}), file=sys.stderr)
    sys.exit(1)

def split_relative(value):
    if value in ("", "."):
        return []
    if "\x00" in value or "\\" in value or value.startswith("/") or value.startswith("//"):
        raise OSError(errno.EPERM, "invalid relative path")
    parts = [part for part in value.split("/") if part and part != "."]
    for part in parts:
        if part == "..":
            raise OSError(errno.EPERM, "path traversal is not allowed")
    return parts

def open_dir(path_value, dir_fd=None):
    return os.open(path_value, DIR_FLAGS, dir_fd=dir_fd)

def walk_dir(root_fd, segments, mkdir_enabled=False):
    current_fd = os.dup(root_fd)
    try:
        for segment in segments:
            try:
                next_fd = open_dir(segment, dir_fd=current_fd)
            except FileNotFoundError:
                if not mkdir_enabled:
                    raise
                os.mkdir(segment, 0o777, dir_fd=current_fd)
                next_fd = open_dir(segment, dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except Exception:
        os.close(current_fd)
        raise

def parent_and_basename(root_fd, relative):
    segments = split_relative(relative)
    if not segments:
        raise OSError(errno.EPERM, "operation requires a non-root path")
    parent_fd = walk_dir(root_fd, segments[:-1])
    return parent_fd, segments[-1]

def encode_stat(st):
    mode = st.st_mode
    return {
        "dev": st.st_dev,
        "gid": st.st_gid,
        "ino": st.st_ino,
        "isDirectory": stat.S_ISDIR(mode),
        "isFile": stat.S_ISREG(mode),
        "isSymbolicLink": stat.S_ISLNK(mode),
        "mode": mode,
        "mtimeMs": st.st_mtime * 1000,
        "nlink": st.st_nlink,
        "size": st.st_size,
        "uid": st.st_uid,
    }

def reject_unsafe_endpoint(st):
    mode = st.st_mode
    if stat.S_ISLNK(mode):
        raise OSError(errno.ELOOP, "symlink endpoint is not allowed")
    if stat.S_ISREG(mode) and st.st_nlink > 1:
        raise OSError(errno.EPERM, "hardlinked file endpoint is not allowed")

def stat_path(root_fd, relative):
    segments = split_relative(relative)
    if not segments:
        return encode_stat(os.fstat(root_fd))
    parent_fd, basename = parent_and_basename(root_fd, relative)
    try:
        st = os.lstat(basename, dir_fd=parent_fd)
        if payload.get("rejectSymlink", True) and stat.S_ISLNK(st.st_mode):
            raise OSError(errno.ELOOP, "symlink endpoint is not allowed")
        return encode_stat(st)
    finally:
        os.close(parent_fd)

def readdir_path(root_fd, relative):
    dir_fd = walk_dir(root_fd, split_relative(relative))
    try:
        names = sorted(os.listdir(dir_fd))
        if not payload.get("withFileTypes", False):
            return names
        entries = []
        for name in names:
            st = os.lstat(name, dir_fd=dir_fd)
            entry = encode_stat(st)
            entry["name"] = name
            entries.append(entry)
        return entries
    finally:
        os.close(dir_fd)

def mkdirp_path(root_fd, relative):
    dir_fd = walk_dir(root_fd, split_relative(relative), mkdir_enabled=True)
    os.close(dir_fd)
    return None

def remove_tree(parent_fd, basename):
    st = os.lstat(basename, dir_fd=parent_fd)
    if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode):
        dir_fd = open_dir(basename, dir_fd=parent_fd)
        try:
            for child in os.listdir(dir_fd):
                remove_tree(dir_fd, child)
        finally:
            os.close(dir_fd)
        os.rmdir(basename, dir_fd=parent_fd)
    else:
        os.unlink(basename, dir_fd=parent_fd)

def remove_path(root_fd, relative):
    parent_fd, basename = parent_and_basename(root_fd, relative)
    try:
        try:
            st = os.lstat(basename, dir_fd=parent_fd)
        except FileNotFoundError:
            if payload.get("force", True):
                return None
            raise
        if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode):
            if payload.get("recursive", False):
                remove_tree(parent_fd, basename)
            else:
                os.rmdir(basename, dir_fd=parent_fd)
        else:
            os.unlink(basename, dir_fd=parent_fd)
        return None
    finally:
        os.close(parent_fd)

def read_path(root_fd, relative):
    parent_fd, basename = parent_and_basename(root_fd, relative)
    try:
        fd = os.open(basename, READ_FLAGS, dir_fd=parent_fd)
        try:
            st = os.fstat(fd)
            reject_unsafe_endpoint(st)
            if not stat.S_ISREG(st.st_mode):
                raise OSError(errno.EPERM, "only regular files can be read")
            chunks = []
            while True:
                chunk = os.read(fd, 1024 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
            return {"base64": base64.b64encode(b"".join(chunks)).decode("ascii"), "stat": encode_stat(st)}
        finally:
            os.close(fd)
    finally:
        os.close(parent_fd)

def write_path(root_fd, relative):
    parent_fd, basename = parent_and_basename(root_fd, relative)
    data = base64.b64decode(payload.get("base64", ""))
    overwrite = payload.get("overwrite", True)
    try:
        if not overwrite:
            try:
                os.lstat(basename, dir_fd=parent_fd)
                raise FileExistsError(errno.EEXIST, "destination exists", basename)
            except FileNotFoundError:
                pass
        prefix = ".fs-safe-" + basename.replace("/", "_") + "-"
        temp_name = None
        fd = None
        try:
            for _ in range(32):
                candidate = prefix + next(tempfile._get_candidate_names())
                try:
                    fd = os.open(candidate, WRITE_FLAGS, 0o600, dir_fd=parent_fd)
                    temp_name = candidate
                    break
                except FileExistsError:
                    continue
            if fd is None or temp_name is None:
                raise FileExistsError(errno.EEXIST, "could not allocate temp file")
            os.write(fd, data)
            os.fsync(fd)
            os.close(fd)
            fd = None
            os.replace(temp_name, basename, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            os.fsync(parent_fd)
            return None
        finally:
            if fd is not None:
                os.close(fd)
            if temp_name is not None:
                try:
                    os.unlink(temp_name, dir_fd=parent_fd)
                except FileNotFoundError:
                    pass
    finally:
        os.close(parent_fd)

def rename_path(root_fd):
    from_parent_fd, from_base = parent_and_basename(root_fd, payload["from"])
    to_parent_fd, to_base = parent_and_basename(root_fd, payload["to"])
    try:
        from_stat = os.lstat(from_base, dir_fd=from_parent_fd)
        reject_unsafe_endpoint(from_stat)
        if not payload.get("overwrite", True):
            try:
                os.lstat(to_base, dir_fd=to_parent_fd)
                raise FileExistsError(errno.EEXIST, "destination exists", to_base)
            except FileNotFoundError:
                pass
        os.rename(from_base, to_base, src_dir_fd=from_parent_fd, dst_dir_fd=to_parent_fd)
        os.fsync(from_parent_fd)
        if from_parent_fd != to_parent_fd:
            os.fsync(to_parent_fd)
        return None
    finally:
        os.close(from_parent_fd)
        os.close(to_parent_fd)

try:
    root_fd = open_dir(root_path)
    try:
        relative = payload.get("relativePath", "")
        if operation == "stat":
            result = stat_path(root_fd, relative)
        elif operation == "readdir":
            result = readdir_path(root_fd, relative)
        elif operation == "mkdirp":
            result = mkdirp_path(root_fd, relative)
        elif operation == "remove":
            result = remove_path(root_fd, relative)
        elif operation == "read":
            result = read_path(root_fd, relative)
        elif operation == "write":
            result = write_path(root_fd, relative)
        elif operation == "rename":
            result = rename_path(root_fd)
        else:
            raise RuntimeError("unknown operation: " + operation)
        print(json.dumps({"ok": True, "result": result}, separators=(",", ":")))
    finally:
        os.close(root_fd)
except Exception as exc:
    fail(type(exc).__name__, str(exc))
`;

type HelperOperation = "stat" | "readdir" | "mkdirp" | "remove" | "read" | "write" | "rename";

const PYTHON_CANDIDATES = [
  process.env.OPENCLAW_FS_SAFE_PYTHON,
  process.env.OPENCLAW_PINNED_PYTHON,
  "/usr/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
].filter((value): value is string => Boolean(value));

let cachedPython = "";

function canExecute(binPath: string): boolean {
  try {
    fsSync.accessSync(binPath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePython(): string {
  if (cachedPython) {
    return cachedPython;
  }
  for (const candidate of PYTHON_CANDIDATES) {
    if (canExecute(candidate)) {
      cachedPython = candidate;
      return cachedPython;
    }
  }
  cachedPython = "python3";
  return cachedPython;
}

function assertPinnedHelperSupported(): void {
  if (process.platform === "win32") {
    throw new FsSafeError(
      "unsupported-platform",
      "fd-relative pinned filesystem operations are not available on Windows",
    );
  }
}

function isSpawnUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const maybeErrno = error as NodeJS.ErrnoException;
  return (
    typeof maybeErrno.syscall === "string" &&
    maybeErrno.syscall.startsWith("spawn") &&
    ["EACCES", "ENOENT", "ENOEXEC"].includes(maybeErrno.code ?? "")
  );
}

export async function runPinnedHelper<T>(
  operation: HelperOperation,
  rootDir: string,
  payload: Record<string, unknown>,
): Promise<T> {
  assertPinnedHelperSupported();
  if (typeof payload.relativePath === "string") {
    splitSafeRelativePath(payload.relativePath);
  }
  if (typeof payload.from === "string") {
    splitSafeRelativePath(payload.from);
  }
  if (typeof payload.to === "string") {
    splitSafeRelativePath(payload.to);
  }

  const child = spawn(resolvePython(), ["-c", PINNED_HELPER_SOURCE, operation, rootDir], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  child.stdin.end(JSON.stringify(payload));

  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    },
  ).catch((error: unknown) => {
    if (isSpawnUnavailable(error)) {
      throw new FsSafeError("helper-unavailable", "Python helper is unavailable", { cause: error });
    }
    throw error;
  });

  const raw = code === 0 ? stdout : stderr;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw.trim());
  } catch {
    throw new FsSafeError(
      "helper-failed",
      `pinned helper failed with code ${code ?? "null"} (${signal ?? "?"}): ${raw.trim()}`,
    );
  }

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("ok" in decoded) ||
    typeof decoded.ok !== "boolean"
  ) {
    throw new FsSafeError("helper-failed", "pinned helper returned an invalid response");
  }
  if (!decoded.ok) {
    const helperCode = "code" in decoded && typeof decoded.code === "string" ? decoded.code : "";
    const message =
      "message" in decoded && typeof decoded.message === "string"
        ? decoded.message
        : "pinned helper failed";
    if (helperCode === "FileNotFoundError") {
      throw new FsSafeError("not-found", "file not found");
    }
    if (helperCode === "NotADirectoryError" || helperCode === "OSError") {
      throw new FsSafeError("path-alias", message);
    }
    if (helperCode === "FileExistsError") {
      throw new FsSafeError("already-exists", message);
    }
    throw new FsSafeError("helper-failed", message);
  }
  return (decoded as unknown as { result: T }).result;
}

export type HelperReadResult = {
  base64: string;
  stat: SafePathStat;
};

export async function helperStat(rootDir: string, relativePath: string): Promise<SafePathStat> {
  return await runPinnedHelper<SafePathStat>("stat", rootDir, { relativePath });
}

export async function helperReaddir(
  rootDir: string,
  relativePath: string,
  withFileTypes: false,
): Promise<string[]>;
export async function helperReaddir(
  rootDir: string,
  relativePath: string,
  withFileTypes: true,
): Promise<SafeDirEntry[]>;
export async function helperReaddir(
  rootDir: string,
  relativePath: string,
  withFileTypes: boolean,
): Promise<string[] | SafeDirEntry[]> {
  return await runPinnedHelper<string[] | SafeDirEntry[]>("readdir", rootDir, {
    relativePath,
    withFileTypes,
  });
}

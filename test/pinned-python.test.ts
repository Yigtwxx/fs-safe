import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafePython, root } from "../src/index.js";
import {
  canFallbackFromPythonError,
  getFsSafePythonConfig,
} from "../src/pinned-python-config.js";
import {
  __resetPinnedPythonWorkerForTest,
  isPinnedHelperUnavailable,
  runPinnedPythonOperation,
} from "../src/pinned-python.js";
import * as configSubpath from "../src/config.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

type FakeChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  ref: ReturnType<typeof vi.fn>;
  stderr: EventEmitter & {
    ref: ReturnType<typeof vi.fn>;
    setEncoding: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  stdin: EventEmitter & {
    ref: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };
  stdout: EventEmitter & {
    ref: ReturnType<typeof vi.fn>;
    setEncoding: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  unref: ReturnType<typeof vi.fn>;
};

const tempDirs = new Set<string>();
const originalEnv = {
  FS_SAFE_PYTHON: process.env.FS_SAFE_PYTHON,
  FS_SAFE_PYTHON_MODE: process.env.FS_SAFE_PYTHON_MODE,
  OPENCLAW_FS_SAFE_PYTHON: process.env.OPENCLAW_FS_SAFE_PYTHON,
  OPENCLAW_FS_SAFE_PYTHON_MODE: process.env.OPENCLAW_FS_SAFE_PYTHON_MODE,
  OPENCLAW_PINNED_PYTHON: process.env.OPENCLAW_PINNED_PYTHON,
  OPENCLAW_PINNED_WRITE_PYTHON: process.env.OPENCLAW_PINNED_WRITE_PYTHON,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function makeChild(
  write?: (line: string, callback?: (error?: Error | null) => void) => void,
): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.ref = vi.fn();
  child.unref = vi.fn();
  child.kill = vi.fn();
  child.stdout = Object.assign(new EventEmitter(), {
    ref: vi.fn(),
    setEncoding: vi.fn(),
    unref: vi.fn(),
  });
  child.stderr = Object.assign(new EventEmitter(), {
    ref: vi.fn(),
    setEncoding: vi.fn(),
    unref: vi.fn(),
  });
  child.stdin = Object.assign(new EventEmitter(), {
    ref: vi.fn(),
    unref: vi.fn(),
    write: vi.fn((line: string, callback?: (error?: Error | null) => void) => {
      write?.(line, callback);
      callback?.();
      return true;
    }),
  });
  return child;
}

function makeRespondingChild(): FakeChild {
  const child = makeChild((line) => {
    const request = JSON.parse(line) as { id: number };
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        `${JSON.stringify({ id: request.id, ok: true, result: { ok: true } })}\n`,
      );
    });
  });
  return child;
}

function makeFailingChild(): FakeChild {
  const child = makeChild();
  queueMicrotask(() => {
    const error = Object.assign(new Error("spawn ENOENT"), {
      code: "ENOENT",
      syscall: "spawn python3",
    });
    child.emit("error", error);
  });
  return child;
}

afterEach(async () => {
  configureFsSafePython({ mode: "auto", pythonPath: undefined });
  __resetPinnedPythonWorkerForTest();
  restoreEnv();
  spawnMock.mockReset();
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("Python helper configuration", () => {
  it("reads environment mode and python path aliases", () => {
    delete process.env.FS_SAFE_PYTHON_MODE;
    delete process.env.OPENCLAW_FS_SAFE_PYTHON_MODE;
    delete process.env.FS_SAFE_PYTHON;
    delete process.env.OPENCLAW_FS_SAFE_PYTHON;
    delete process.env.OPENCLAW_PINNED_PYTHON;
    delete process.env.OPENCLAW_PINNED_WRITE_PYTHON;

    expect(getFsSafePythonConfig()).toEqual({ mode: "auto", pythonPath: undefined });

    process.env.FS_SAFE_PYTHON_MODE = "off";
    process.env.FS_SAFE_PYTHON = "/tmp/python-a";
    expect(getFsSafePythonConfig()).toEqual({ mode: "off", pythonPath: "/tmp/python-a" });

    delete process.env.FS_SAFE_PYTHON_MODE;
    delete process.env.FS_SAFE_PYTHON;
    process.env.OPENCLAW_FS_SAFE_PYTHON_MODE = "required";
    process.env.OPENCLAW_PINNED_WRITE_PYTHON = "/tmp/python-b";
    expect(getFsSafePythonConfig()).toEqual({
      mode: "require",
      pythonPath: "/tmp/python-b",
    });

    configureFsSafePython({ mode: "auto", pythonPath: "/tmp/python-c" });
    expect(getFsSafePythonConfig()).toEqual({ mode: "auto", pythonPath: "/tmp/python-c" });
    expect(configSubpath.getFsSafePythonConfig()).toEqual({
      mode: "auto",
      pythonPath: "/tmp/python-c",
    });
  });

  it("only allows helper fallback errors outside require mode", () => {
    const unavailable = Object.assign(new Error("missing"), { code: "helper-unavailable" });
    const unsupportedPlatform = Object.assign(new Error("unsupported"), { code: "unsupported-platform" });

    configureFsSafePython({ mode: "auto" });
    expect(canFallbackFromPythonError(unavailable)).toBe(true);
    expect(canFallbackFromPythonError(unsupportedPlatform)).toBe(true);

    configureFsSafePython({ mode: "off" });
    expect(canFallbackFromPythonError(unavailable)).toBe(true);
    expect(canFallbackFromPythonError(unsupportedPlatform)).toBe(true);

    configureFsSafePython({ mode: "require" });
    expect(canFallbackFromPythonError(unavailable)).toBe(false);
    expect(canFallbackFromPythonError(unsupportedPlatform)).toBe(false);
  });
});

describe("persistent Python helper worker", () => {
  it("reuses one worker and unreferences it while idle", async () => {
    if (process.platform === "win32") {
      configureFsSafePython({ mode: "auto", pythonPath: "/tmp/fake-python" });
      await expect(
        runPinnedPythonOperation<{ ok: boolean }>({
          operation: "stat",
          rootPath: "/tmp/root",
          payload: { relativePath: "a.txt" },
        }),
      ).rejects.toMatchObject({ code: "unsupported-platform" });
      return;
    }

    const child = makeRespondingChild();
    spawnMock.mockReturnValue(child);
    configureFsSafePython({ mode: "auto", pythonPath: "/tmp/fake-python" });

    await expect(
      runPinnedPythonOperation<{ ok: boolean }>({
        operation: "stat",
        rootPath: "/tmp/root",
        payload: { relativePath: "a.txt" },
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      runPinnedPythonOperation<{ ok: boolean }>({
        operation: "stat",
        rootPath: "/tmp/root",
        payload: { relativePath: "b.txt" },
      }),
    ).resolves.toEqual({ ok: true });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(child.ref).toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalled();
    expect(child.stdin.write).toHaveBeenCalledTimes(2);
  });

  it("falls back in auto mode but fails closed in require mode", async () => {
    const rootDir = await tempRoot("fs-safe-python-policy-");
    await fs.writeFile(path.join(rootDir, "file.txt"), "ok");

    spawnMock.mockImplementation(makeFailingChild);
    configureFsSafePython({ mode: "auto", pythonPath: "/tmp/missing-python" });
    const autoRoot = await root(rootDir);
    await expect(autoRoot.stat("file.txt")).resolves.toMatchObject({
      isFile: true,
    });
    await expect(autoRoot.list("")).resolves.toEqual(["file.txt"]);
    await fs.writeFile(path.join(rootDir, "move.txt"), "move");
    await autoRoot.move("move.txt", "moved.txt");
    await expect(fs.readFile(path.join(rootDir, "moved.txt"), "utf8")).resolves.toBe("move");

    __resetPinnedPythonWorkerForTest();
    spawnMock.mockClear();
    spawnMock.mockImplementation(makeFailingChild);
    configureFsSafePython({ mode: "require", pythonPath: "/tmp/missing-python" });
    await expect((await root(rootDir)).stat("file.txt")).rejects.toMatchObject({
      code: process.platform === "win32" ? "unsupported-platform" : "helper-unavailable",
    });
  });

  it.runIf(process.platform !== "win32")("ignores stale events from a replaced worker", async () => {
    const oldChild = makeChild();
    const newChild = makeChild((line) => {
      const request = JSON.parse(line) as { id: number };
      queueMicrotask(() => {
        newChild.stdout.emit(
          "data",
          `${JSON.stringify({ id: request.id, ok: true, result: { ok: true } })}\n`,
        );
      });
    });
    spawnMock.mockReturnValueOnce(oldChild).mockReturnValueOnce(newChild);
    configureFsSafePython({ mode: "auto", pythonPath: "/tmp/fake-python" });

    const first = runPinnedPythonOperation({
      operation: "stat",
      rootPath: "/tmp/root",
      payload: { relativePath: "a.txt" },
    });
    oldChild.emit(
      "error",
      Object.assign(new Error("old failed"), { code: "ENOENT", syscall: "spawn python3" }),
    );
    await expect(first).rejects.toMatchObject({ code: "helper-unavailable" });

    const second = runPinnedPythonOperation({
      operation: "stat",
      rootPath: "/tmp/root",
      payload: { relativePath: "b.txt" },
    });
    oldChild.emit("close", 1, null);

    await expect(second).resolves.toEqual({ ok: true });
  });

  it("classifies helper unavailable errors", () => {
    expect(isPinnedHelperUnavailable(Object.assign(new Error("missing"), {
      code: "helper-unavailable",
    }))).toBe(true);
    expect(isPinnedHelperUnavailable(Object.assign(new Error("other"), {
      code: "helper-failed",
    }))).toBe(false);
  });

  it("maps root identity mismatches", async () => {
    const child = makeChild((line) => {
      const request = JSON.parse(line) as { id: number };
      queueMicrotask(() => {
        child.stdout.emit(
          "data",
          `${JSON.stringify({
            code: "RuntimeError",
            id: request.id,
            message: "fs-safe-root-mismatch",
            ok: false,
          })}\n`,
        );
      });
    });
    spawnMock.mockReturnValue(child);
    configureFsSafePython({ mode: "auto", pythonPath: "/tmp/fake-python" });

    await expect(
      runPinnedPythonOperation({
        operation: "stat",
        rootPath: "/tmp/root",
        payload: { relativePath: "" },
      }),
    ).rejects.toMatchObject({
      code: process.platform === "win32" ? "unsupported-platform" : "path-mismatch",
    });
  });
});

export type FsSafePythonMode = "auto" | "off" | "require";

export type FsSafePythonConfig = {
  mode: FsSafePythonMode;
  pythonPath?: string;
};

let overrideConfig: Partial<FsSafePythonConfig> = {};

function parseMode(value: string | undefined): FsSafePythonMode | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "never") {
    return "off";
  }
  if (normalized === "1" || normalized === "true" || normalized === "on" || normalized === "auto") {
    return "auto";
  }
  if (normalized === "required" || normalized === "require") {
    return "require";
  }
  return undefined;
}

export function configureFsSafePython(config: Partial<FsSafePythonConfig>): void {
  overrideConfig = { ...overrideConfig, ...config };
}

export function getFsSafePythonConfig(): FsSafePythonConfig {
  return {
    mode:
      overrideConfig.mode ??
      parseMode(process.env.FS_SAFE_PYTHON_MODE) ??
      parseMode(process.env.OPENCLAW_FS_SAFE_PYTHON_MODE) ??
      "auto",
    pythonPath:
      overrideConfig.pythonPath ??
      process.env.FS_SAFE_PYTHON ??
      process.env.OPENCLAW_FS_SAFE_PYTHON ??
      process.env.OPENCLAW_PINNED_PYTHON ??
      process.env.OPENCLAW_PINNED_WRITE_PYTHON,
  };
}

export function canFallbackFromPythonError(error: unknown): boolean {
  return (
    getFsSafePythonConfig().mode !== "require" &&
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === "helper-unavailable"
  );
}

import path from "node:path";

function getEnvValueCaseInsensitive(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const direct = env[name];
  if (direct !== undefined) {
    return direct;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

function normalizeWindowsInstallRoot(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !path.win32.isAbsolute(trimmed)) {
    return null;
  }
  return trimmed.replace(/[\\/]+$/, "");
}

function resolveWindowsSystemRoot(env?: NodeJS.ProcessEnv): string {
  const source = env ?? process.env;
  return (
    normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(source, "SystemRoot")) ??
    normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(source, "WINDIR")) ??
    "C:\\Windows"
  );
}

export function resolveWindowsSystemCommand(
  command: string,
  env?: NodeJS.ProcessEnv,
): string {
  return path.win32.join(resolveWindowsSystemRoot(env), "System32", command);
}

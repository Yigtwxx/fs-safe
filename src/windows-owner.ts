import { resolveWindowsSystemCommand } from "./windows-command.js";

export type WindowsOwnerExec = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export type WindowsOwnerSummary = {
  sid?: string;
  currentUserSid?: string;
  principalSids?: Record<string, string>;
  remote?: boolean;
  trusted?: boolean;
  error?: string;
};

const SID_RE = /^\*?s-\d+-\d+(-\d+)+$/i;
const TRUSTED_OWNER_SIDS = new Set(["s-1-5-18", "s-1-5-32-544"]);

function normalizeSid(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("*") ? normalized.slice(1) : normalized;
}

function encodePowerShellCommand(source: string): string {
  return Buffer.from(source, "utf16le").toString("base64");
}

function windowsOwnerQueryCommand(targetPath: string): string {
  const encodedPath = Buffer.from(targetPath, "utf8").toString("base64");
  return [
    "$ErrorActionPreference='Stop'",
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$acl=Get-Acl -LiteralPath $p",
    "$owner=$acl.Owner",
    "$ownerSid=if($owner -match '^S-\\d+-\\d+(?:-\\d+)+$'){$owner}else{(New-Object System.Security.Principal.NTAccount($owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value}",
    "$currentSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$root=[IO.Path]::GetPathRoot($p)",
    "$extendedDrive=$p.Length -ge 7 -and $p.StartsWith('\\\\?\\') -and [char]::IsLetter($p[4]) -and $p[5] -eq ':' -and $p[6] -eq '\\'",
    "$namespacePath=$p.StartsWith('\\\\')",
    "$remote=($namespacePath -and -not $extendedDrive) -or ([IO.DriveInfo]::new($root).DriveType -eq [IO.DriveType]::Network)",
    "$principalSids=@($acl.Access|ForEach-Object {@{name=$_.IdentityReference.Value;sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}})",
    "@{owner=$owner;ownerSid=$ownerSid;currentUserSid=$currentSid;principalSids=$principalSids;remote=$remote}|ConvertTo-Json -Depth 4 -Compress",
  ].join(";");
}

function windowsPrincipalQueryCommand(principals: string[]): string {
  const encodedPrincipals = Buffer.from(JSON.stringify(principals), "utf8").toString("base64");
  return [
    "$ErrorActionPreference='Stop'",
    `$names=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPrincipals}'))|ConvertFrom-Json`,
    "$rows=@($names|ForEach-Object {@{name=$_;sid=(New-Object System.Security.Principal.NTAccount($_)).Translate([System.Security.Principal.SecurityIdentifier]).Value}})",
    "ConvertTo-Json -InputObject $rows -Compress",
  ].join(";");
}

function parsePrincipalSidRows(value: unknown): Record<string, string> {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const name = "name" in row && typeof row.name === "string" ? row.name.trim() : "";
    const sid = "sid" in row && typeof row.sid === "string" ? normalizeSid(row.sid) : "";
    if (name && SID_RE.test(sid)) {
      result[name.toLowerCase()] = sid;
    }
  }
  return result;
}

export async function resolveWindowsPrincipalSids(params: {
  principals: string[];
  known?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  exec: WindowsOwnerExec;
}): Promise<Record<string, string>> {
  const principals = [...new Set(params.principals.map((value) => value.trim()).filter(Boolean))];
  const known = Object.fromEntries(
    Object.entries(params.known ?? {}).map(([name, sid]) => [name.toLowerCase(), normalizeSid(sid)]),
  );
  const unresolved = principals.filter((principal) => !known[principal.toLowerCase()]);
  if (unresolved.length === 0) {
    return known;
  }
  const command = resolveWindowsSystemCommand(
    String.raw`WindowsPowerShell\v1.0\powershell.exe`,
    params.env,
  );
  const { stdout } = await params.exec(command, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodePowerShellCommand(windowsPrincipalQueryCommand(unresolved)),
  ]);
  const resolved = { ...known, ...parsePrincipalSidRows(JSON.parse(stdout.trim())) };
  if (principals.some((principal) => !resolved[principal.toLowerCase()])) {
    throw new Error("Windows ACL principal translation returned incomplete SID data");
  }
  return resolved;
}

export async function resolveWindowsCurrentUserSid(params: {
  env?: NodeJS.ProcessEnv;
  exec: WindowsOwnerExec;
}): Promise<string | null> {
  try {
    const { stdout, stderr } = await params.exec(
      resolveWindowsSystemCommand("whoami.exe", params.env),
      ["/user", "/fo", "csv", "/nh"],
    );
    const match = `${stdout}\n${stderr}`.match(/\*?S-\d+-\d+(?:-\d+)+/i);
    return match ? normalizeSid(match[0]) : null;
  } catch {
    return null;
  }
}

export async function inspectWindowsOwner(params: {
  targetPath: string;
  env?: NodeJS.ProcessEnv;
  exec: WindowsOwnerExec;
}): Promise<WindowsOwnerSummary> {
  try {
    const command = resolveWindowsSystemCommand(
      String.raw`WindowsPowerShell\v1.0\powershell.exe`,
      params.env,
    );
    const { stdout } = await params.exec(command, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodePowerShellCommand(windowsOwnerQueryCommand(params.targetPath)),
    ]);
    const parsed = JSON.parse(stdout.trim()) as {
      ownerSid?: unknown;
      currentUserSid?: unknown;
      principalSids?: unknown;
      remote?: unknown;
    };
    const ownerSid =
      typeof parsed.ownerSid === "string" && SID_RE.test(parsed.ownerSid)
        ? normalizeSid(parsed.ownerSid)
        : undefined;
    const currentUserSid =
      typeof parsed.currentUserSid === "string" && SID_RE.test(parsed.currentUserSid)
        ? normalizeSid(parsed.currentUserSid)
        : undefined;
    if (!ownerSid || !currentUserSid) {
      return { error: "Windows owner query returned invalid SID data" };
    }
    const remote = parsed.remote === true;
    return {
      sid: ownerSid,
      currentUserSid,
      principalSids: parsePrincipalSidRows(parsed.principalSids),
      remote,
      trusted: !remote && (ownerSid === currentUserSid || TRUSTED_OWNER_SIDS.has(ownerSid)),
    };
  } catch (err) {
    return { error: String(err) };
  }
}

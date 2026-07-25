import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const [notesPath, manifestPath, repository, runId] = process.argv.slice(2);
if (!notesPath || !manifestPath || !repository || !runId) {
  throw new Error("usage: append-release-proof <notes> <manifest> <repository> <run-id>");
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const lines = [
  "",
  "### Published packages",
  "",
  "| Package | Registry tarball | Integrity | Provenance |",
  "|---|---|---|---|",
];
for (const artifact of manifest) {
  const spec = `${artifact.name}@${artifact.version}`;
  const dist = JSON.parse(execFileSync("npm", ["view", spec, "dist", "--json"], {
    encoding: "utf8",
  }));
  if (dist.integrity !== artifact.integrity || !dist.tarball || !dist.attestations?.url) {
    throw new Error(`${spec} registry proof is incomplete or does not match the release artifact`);
  }
  lines.push(
    `| [${spec}](https://www.npmjs.com/package/${artifact.name}/v/${artifact.version}) | [tgz](${dist.tarball}) | \`${dist.integrity}\` | [attestation](${dist.attestations.url}) |`,
  );
}
lines.push(
  "",
  `Release proof: [GitHub Actions run](https://github.com/${repository}/actions/runs/${runId}).`,
  "",
);
appendFileSync(notesPath, `${lines.join("\n")}\n`);

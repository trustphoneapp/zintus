import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
const required = [
  "ZINTUS_ENGINEER_REPOSITORY_ROOT", "ZINTUS_ENGINEER_REPOSITORY_ID", "ZINTUS_ENGINEER_REPOSITORY_PROVIDER",
  "ZINTUS_ENGINEER_REPOSITORY_OWNER", "ZINTUS_ENGINEER_REPOSITORY_NAME", "ZINTUS_ENGINEER_REPOSITORY_ORIGIN_URL",
  "ZINTUS_ENGINEER_BASE_BRANCH", "ZINTUS_ENGINEER_BASE_COMMIT_SHA", "ZINTUS_ENGINEER_IMAGE", "ZINTUS_ENGINEER_IMAGE_DIGEST",
] as const;

for (const name of required) add(name, Boolean(process.env[name]?.trim()), process.env[name] ? "configured" : "missing");
const digest = process.env.ZINTUS_ENGINEER_IMAGE_DIGEST ?? "";
const image = process.env.ZINTUS_ENGINEER_IMAGE ?? "";
add("immutable image digest", /^sha256:[a-f0-9]{64}$/i.test(digest) && image.endsWith(`@${digest}`), "requires repository@sha256 plus matching digest");
const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", shell: false, timeout: 10_000 });
add("Docker daemon", docker.status === 0, docker.status === 0 ? "available" : "unavailable");

const root = process.env.ZINTUS_ENGINEER_REPOSITORY_ROOT;
const base = process.env.ZINTUS_ENGINEER_BASE_COMMIT_SHA;
const branch = process.env.ZINTUS_ENGINEER_BASE_BRANCH;
if (root && base && branch) {
  const repositoryRoot = realpathSync(root);
  const git = (args: string[]) => spawnSync("git", ["-C", repositoryRoot, ...args], { encoding: "utf8", shell: false, timeout: 10_000 });
  const object = git(["rev-parse", "--verify", `${base}^{commit}`]);
  const ref = git(["rev-parse", "--verify", `${branch}^{commit}`]);
  const exact = object.status === 0 && ref.status === 0 && object.stdout.trim().toLowerCase() === base.toLowerCase() && ref.stdout.trim().toLowerCase() === base.toLowerCase();
  add("exact base branch", exact, exact ? base : "branch/base mismatch");
  const origin = git(["remote", "get-url", "origin"]);
  add("repository origin", origin.status === 0 && Boolean(origin.stdout.trim()), origin.status === 0 ? "available" : "unavailable");
}

const result = { ok: checks.every((check) => check.ok), checks };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;

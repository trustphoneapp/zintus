import { describe, expect, test } from "bun:test";
import {
  buildDockerArgv,
  createDockerSpawn,
  dockerAvailable,
} from "./sandbox-docker.js";

describe("docker sandbox spawner (P3)", () => {
  test("buildDockerArgv hardens the container and mounts the sandbox root", () => {
    const argv = buildDockerArgv(["bun", "run", "test"], {
      image: "oven/bun:1",
      hostRoot: "/home/me/project",
      network: false,
      memory: "2g",
      workdir: "/workspace",
    });
    const joined = argv.join(" ");
    expect(argv[0]).toBe("run");
    expect(joined).toContain("--rm");
    expect(joined).toContain("--network=none");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("no-new-privileges");
    expect(joined).toContain("/home/me/project:/workspace:rw");
    // The allowlisted command is passed through verbatim, after the image.
    expect(argv.slice(-3)).toEqual(["bun", "run", "test"]);
    // Image sits immediately before the command.
    expect(argv[argv.length - 4]).toBe("oven/bun:1");
  });

  test("network:true opts into default networking", () => {
    const argv = buildDockerArgv(["bun", "run", "build"], {
      image: "oven/bun:1",
      hostRoot: "/x",
      network: true,
      memory: "1g",
      workdir: "/workspace",
    });
    expect(argv.join(" ")).toContain("--network=default");
  });

  test("createDockerSpawn wraps the command in docker run and maps the result", () => {
    const calls: Array<{ cmd: string; argv: string[] }> = [];
    const fakeSpawn = ((cmd: string, argv: string[]) => {
      calls.push({ cmd, argv });
      return { status: 0, stdout: "ok\n", stderr: "", error: undefined } as ReturnType<
        typeof import("node:child_process").spawnSync
      >;
    }) as typeof import("node:child_process").spawnSync;

    const spawn = createDockerSpawn({ rawSpawn: fakeSpawn, hostRoot: "/proj" });
    const result = spawn(["bun", "test"], { cwd: "/proj", timeoutMs: 1000 });

    expect(calls[0]?.cmd).toBe("docker");
    expect(calls[0]?.argv[0]).toBe("run");
    expect(calls[0]?.argv.join(" ")).toContain("/proj:/workspace:rw");
    expect(calls[0]?.argv.slice(-2)).toEqual(["bun", "test"]);
    // spawnSync returns synchronously here (fake), so result is not a Promise.
    expect(result).toMatchObject({ code: 0, stdout: "ok\n", timedOut: false });
  });

  test("createDockerSpawn surfaces a timeout honestly", () => {
    const fakeSpawn = (() => ({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    })) as unknown as typeof import("node:child_process").spawnSync;
    const spawn = createDockerSpawn({ rawSpawn: fakeSpawn });
    const result = spawn(["bun", "test"], { cwd: "/x", timeoutMs: 1 });
    expect(result).toMatchObject({ timedOut: true });
  });

  test("dockerAvailable returns false when the probe throws", () => {
    const throwing = (() => {
      throw new Error("no docker");
    }) as unknown as typeof import("node:child_process").spawnSync;
    expect(dockerAvailable(throwing)).toBe(false);
  });
});

import chalk from "chalk";
import { isProviderId, PROVIDER_IDS } from "@zintus/types";
import {
  createProject,
  deleteProject,
  getActiveProjectName,
  getProject,
  listProjects,
  setActiveProject,
} from "../lib/projects.js";

export async function runProjectsList(): Promise<void> {
  const [projects, active] = await Promise.all([
    listProjects(),
    getActiveProjectName(),
  ]);
  if (projects.length === 0) {
    console.log(chalk.dim("No projects yet."));
    console.log(
      chalk.dim('Create one: zintus projects create <name> --instructions "…"'),
    );
    return;
  }
  console.log(chalk.bold("Projects:\n"));
  for (const p of projects) {
    const marker = p.name === active ? chalk.green("  ● active") : "";
    console.log(`  ${chalk.cyan(p.name)}${marker}`);
    if (p.defaultProvider) {
      console.log(chalk.dim(`      provider: ${p.defaultProvider}`));
    }
    if (p.instructions) {
      console.log(chalk.dim(`      ${p.instructions.slice(0, 80)}`));
    }
  }
}

export async function runProjectsCreate(
  name: string,
  options: { instructions?: string; provider?: string },
): Promise<void> {
  let defaultProvider = null;
  if (options.provider) {
    if (!isProviderId(options.provider)) {
      console.error(
        chalk.red(`Unknown provider: ${options.provider}`),
        chalk.dim(`\nValid: ${PROVIDER_IDS.join(", ")}`),
      );
      process.exit(1);
    }
    defaultProvider = options.provider;
  }
  await createProject({
    name,
    instructions: options.instructions,
    defaultProvider,
  });
  console.log(chalk.green(`✓ Created project "${name}"`));
}

export async function runProjectsDelete(name: string): Promise<void> {
  const existed = await deleteProject(name);
  console.log(
    existed
      ? chalk.green(`✓ Deleted project "${name}"`)
      : chalk.yellow(`No project "${name}"`),
  );
}

export async function runProjectsUse(name: string): Promise<void> {
  const project = await getProject(name);
  if (!project) {
    console.error(
      chalk.red(`No project "${name}".`),
      chalk.dim("\nList them: zintus projects list"),
    );
    process.exit(1);
  }
  await setActiveProject(name);
  console.log(
    chalk.green(`✓ Active project: ${name}`),
    chalk.dim("— its instructions now lead each `zintus chat`. Clear: zintus projects clear"),
  );
}

export async function runProjectsClear(): Promise<void> {
  await setActiveProject(null);
  console.log(chalk.green("✓ No active project"));
}

import type { EngineerManifest } from "./engineer";

export interface FrozenPlanCapability {
  id: "model-reads" | "builder-writes" | "delete" | "commands" | "model-network" | "local-git" | "github";
  label: string;
  summary: string;
}

export function frozenPlanCapabilities(
  manifest: EngineerManifest,
  options: { githubConnected: boolean },
): FrozenPlanCapability[] {
  return [
    {
      id: "model-reads",
      label: "Model reads",
      summary: `Planning used bounded, secret-filtered excerpts from the exact base commit. During build, model tools can read only the ${manifest.allowedPaths.length} allowed path ${manifest.allowedPaths.length === 1 ? "pattern" : "patterns"}, minus every denied path.`,
    },
    {
      id: "builder-writes",
      label: "Builder create / overwrite",
      summary: "Builder can create or overwrite files only inside the same frozen allowed-path boundary, in an isolated worktree. Every changed path is checked again before verification.",
    },
    {
      id: "delete",
      label: "Delete behavior",
      summary: "There is no dedicated delete tool. Exact authorized commands run in the writable isolated worktree and may change files; the resulting diff and path scope remain subject to verification.",
    },
    {
      id: "commands",
      label: "Exact offline commands",
      summary: manifest.allowedCommands.length
        ? `${manifest.allowedCommands.length} exact ${manifest.allowedCommands.length === 1 ? "command is" : "commands are"} authorized. Commands run without a shell in a hardened container with network disabled.`
        : "No repository command is authorized. Command execution remains unavailable for this run.",
    },
    {
      id: "model-network",
      label: "Model network",
      summary: "Planner, Builder, and Reviewer provider calls use the network outside the command sandbox and count against the frozen run budget. Repository commands remain offline.",
    },
    {
      id: "local-git",
      label: "Local Git checkpoints",
      summary: "The Supervisor may create an isolated worktree and local checkpoint commits. Builder cannot access Git credentials, push, merge, deploy, or change workflow state.",
    },
    {
      id: "github",
      label: "Conditional GitHub effects",
      summary: options.githubConnected
        ? `Only after matching verification evidence and ${manifest.humanGateRequired ? "the required human approval" : "the configured publication policy"}, the Supervisor may inspect the base, create and push a run branch, and open a draft pull request. It does not merge or deploy.`
        : "No connected GitHub publication capability is shown. This frozen run remains local unless publication is separately configured and admitted later; Zintus never merges or deploys automatically.",
    },
  ];
}

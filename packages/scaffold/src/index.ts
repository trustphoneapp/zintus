import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * @zintus/scaffold — P4 project scaffolder (artifacts → shippable starter).
 *
 * The agent can already WRITE files; a scaffolder gives it (and `zintus
 * scaffold`) a curated set of coherent, deploy-ready starters instead of
 * generating boilerplate from scratch each time. Deliberately small and
 * dependency-free: a template is just a name → files map plus an optional
 * deploy-config generator. Deploying is a [HUMAN] step (their Cloudflare /
 * Vercel / Fly account); we emit the correct config file, not a deploy.
 *
 * Honesty: these are minimal, real, buildable starters — not a substitute for
 * a full framework init. Each README states exactly what it is and the next
 * (human) step to run/deploy it.
 */

export type DeployTarget = "cloudflare" | "vercel" | "fly" | "none";

export interface ScaffoldFile {
  /** Path relative to the target directory. */
  path: string;
  contents: string;
}

export interface TemplateContext {
  /** Project name (kebab-case; used in package.json + config). */
  name: string;
  deploy: DeployTarget;
}

export interface Template {
  id: string;
  title: string;
  description: string;
  /** Deploy targets this template can emit config for. */
  supports: DeployTarget[];
  build(ctx: TemplateContext): ScaffoldFile[];
}

function pkg(name: string, extra: Record<string, unknown>): string {
  return `${JSON.stringify({ name, version: "0.1.0", private: true, ...extra }, null, 2)}\n`;
}

/** Emit the deploy-config file for a target (empty for "none"/unsupported). */
export function deployFiles(
  template: Template,
  ctx: TemplateContext,
): ScaffoldFile[] {
  if (ctx.deploy === "none" || !template.supports.includes(ctx.deploy)) return [];
  switch (ctx.deploy) {
    case "cloudflare":
      return [
        {
          path: "wrangler.toml",
          contents: `name = "${ctx.name}"\nmain = "src/index.ts"\ncompatibility_date = "2026-07-01"\n`,
        },
      ];
    case "vercel":
      return [
        {
          path: "vercel.json",
          contents: `${JSON.stringify({ $schema: "https://openapi.vercel.sh/vercel.json", framework: "nextjs" }, null, 2)}\n`,
        },
      ];
    case "fly":
      return [
        {
          path: "fly.toml",
          contents: `app = "${ctx.name}"\nprimary_region = "iad"\n\n[http_service]\n  internal_port = 8080\n  force_https = true\n`,
        },
      ];
    default:
      return [];
  }
}

const nextSite: Template = {
  id: "next-site",
  title: "Next.js site",
  description: "Minimal Next.js 16 App-Router site (one page).",
  supports: ["vercel", "none"],
  build(ctx) {
    return [
      {
        path: "package.json",
        contents: pkg(ctx.name, {
          scripts: { dev: "next dev", build: "next build", start: "next start" },
          dependencies: { next: "^16.0.0", react: "^19.0.0", "react-dom": "^19.0.0" },
        }),
      },
      {
        path: "app/page.tsx",
        contents: `export default function Home() {\n  return <main style={{ padding: 48 }}><h1>${ctx.name}</h1><p>Scaffolded by Zintus.</p></main>;\n}\n`,
      },
      {
        path: "app/layout.tsx",
        contents: `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
      },
      {
        path: "README.md",
        contents: `# ${ctx.name}\n\nMinimal Next.js 16 site scaffolded by Zintus.\n\n## Run\n\n\`\`\`bash\nnpm install\nnpm run dev   # http://localhost:3000\n\`\`\`\n\n${ctx.deploy === "vercel" ? "## Deploy\n\n`vercel` (needs your Vercel account).\n" : ""}`,
      },
    ];
  },
};

const workerApi: Template = {
  id: "worker-api",
  title: "Cloudflare Worker API",
  description: "Minimal Hono-style JSON API on Cloudflare Workers.",
  supports: ["cloudflare", "none"],
  build(ctx) {
    return [
      {
        path: "package.json",
        contents: pkg(ctx.name, {
          scripts: { dev: "wrangler dev", deploy: "wrangler deploy" },
          devDependencies: { wrangler: "^4.0.0", "@cloudflare/workers-types": "^4.0.0" },
        }),
      },
      {
        path: "src/index.ts",
        contents: `export default {\n  async fetch(request: Request): Promise<Response> {\n    const url = new URL(request.url);\n    if (url.pathname === "/health") {\n      return Response.json({ ok: true });\n    }\n    return Response.json({ app: "${ctx.name}", path: url.pathname });\n  },\n};\n`,
      },
      {
        path: "README.md",
        contents: `# ${ctx.name}\n\nMinimal Cloudflare Worker JSON API scaffolded by Zintus.\n\n## Run\n\n\`\`\`bash\nnpm install\nnpm run dev\ncurl localhost:8787/health\n\`\`\`\n\n## Deploy\n\n\`npm run deploy\` (needs \`wrangler login\` — your Cloudflare account).\n`,
      },
    ];
  },
};

const expoApp: Template = {
  id: "expo-app",
  title: "Expo app",
  description: "Minimal Expo (React Native) single-screen app.",
  supports: ["none"],
  build(ctx) {
    return [
      {
        path: "package.json",
        contents: pkg(ctx.name, {
          main: "index.ts",
          scripts: { start: "expo start" },
          dependencies: { expo: "^56.0.0", react: "^19.0.0", "react-native": "0.79.0" },
        }),
      },
      {
        path: "App.tsx",
        contents: `import { Text, View } from "react-native";\n\nexport default function App() {\n  return (\n    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>\n      <Text>${ctx.name} — scaffolded by Zintus</Text>\n    </View>\n  );\n}\n`,
      },
      {
        path: "README.md",
        contents: `# ${ctx.name}\n\nMinimal Expo app scaffolded by Zintus.\n\n## Run\n\n\`\`\`bash\nnpm install\nnpm start   # then press i / a, or scan the QR in Expo Go\n\`\`\`\n`,
      },
    ];
  },
};

export const TEMPLATES: readonly Template[] = [nextSite, workerApi, expoApp];

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** Validate a project name: kebab-case, npm-safe. */
export function isValidProjectName(name: string): boolean {
  return /^[a-z][a-z0-9-]{0,213}$/.test(name);
}

export interface ScaffoldResult {
  targetDir: string;
  files: string[];
}

/**
 * Materialize a template into `parentDir/name`. Refuses to overwrite a
 * non-empty target (returns an error rather than clobbering). Pure file
 * emission — no network, no install, no deploy.
 */
export function scaffold(opts: {
  templateId: string;
  name: string;
  parentDir: string;
  deploy?: DeployTarget;
}): ScaffoldResult {
  if (!isValidProjectName(opts.name)) {
    throw new Error(
      `Invalid project name "${opts.name}" — use kebab-case (a-z, 0-9, -), starting with a letter.`,
    );
  }
  const template = getTemplate(opts.templateId);
  if (!template) {
    throw new Error(
      `Unknown template "${opts.templateId}". Available: ${TEMPLATES.map((t) => t.id).join(", ")}.`,
    );
  }
  const deploy = opts.deploy ?? "none";
  const targetDir = path.join(opts.parentDir, opts.name);
  if (existsSync(path.join(targetDir, "package.json"))) {
    throw new Error(`Target already looks like a project: ${targetDir}`);
  }
  const ctx: TemplateContext = { name: opts.name, deploy };
  const files = [...template.build(ctx), ...deployFiles(template, ctx)];
  const written: string[] = [];
  for (const f of files) {
    const dest = path.join(targetDir, f.path);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, f.contents);
    written.push(f.path);
  }
  return { targetDir, files: written };
}

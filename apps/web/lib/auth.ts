/**
 * Better Auth server config — used when apps/web is deployed to Cloudflare
 * Workers/Pages via @cloudflare/next-on-pages.
 *
 * When deployed to Vercel (default), auth is handled by the separate relay
 * worker (workers/relay/) and the web app uses the cloud.ts client instead.
 *
 * To enable this, install: better-auth better-auth-cloudflare
 * and set BETTER_AUTH_SECRET, BETTER_AUTH_URL in the Cloudflare deployment.
 */

export interface CloudflareEnv {
  DB: unknown;       // D1Database
  KV: unknown;       // KVNamespace
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  RESEND_API_KEY: string;
}

/**
 * Factory that creates a per-request Better Auth instance.
 * MUST be called per-request — never as a module-level singleton —
 * to avoid D1 write-lock contention in Workers.
 *
 * Uncomment when better-auth + better-auth-cloudflare are installed and
 * the app is deployed to Cloudflare Pages/Workers:
 *
 * ```typescript
 * import { betterAuth } from "better-auth/minimal"
 * import { withCloudflare } from "better-auth-cloudflare"
 * import { magicLink } from "better-auth/plugins"
 *
 * export const createAuth = (env: CloudflareEnv) =>
 *   betterAuth({
 *     ...withCloudflare(
 *       { d1Native: env.DB as D1Database, kv: env.KV as KVNamespace },
 *       {
 *         secret: env.BETTER_AUTH_SECRET,
 *         baseURL: env.BETTER_AUTH_URL,
 *         session: {
 *           storeSessionInDatabase: true,
 *           updateAge: 60 * 15,
 *           // cookieCache DISABLED — better-auth bug #4203 causes 5-min logout on Workers.
 *           // Re-enable only when upstream confirms fix.
 *         },
 *         plugins: [
 *           magicLink({
 *             sendMagicLink: async ({ email, url }) => {
 *               await fetch("https://api.resend.com/emails", {
 *                 method: "POST",
 *                 headers: {
 *                   Authorization: `Bearer ${env.RESEND_API_KEY}`,
 *                   "Content-Type": "application/json",
 *                 },
 *                 body: JSON.stringify({
 *                   from: "Zintus <auth@zintus.app>",
 *                   to: email,
 *                   subject: "Sign in to Zintus",
 *                   html: `<a href="${url}">Sign in to Zintus</a>`,
 *                 }),
 *               })
 *             },
 *           }),
 *         ],
 *         socialProviders: {
 *           google: {
 *             clientId: env.GOOGLE_CLIENT_ID,
 *             clientSecret: env.GOOGLE_CLIENT_SECRET,
 *           },
 *         },
 *       },
 *     ),
 *   })
 * ```
 *
 * Notes:
 * - Use `better-auth/minimal` entry point to tree-shake unused features.
 * - Create ONE auth instance per request — never a global singleton.
 */

export function createAuth(_env: CloudflareEnv): never {
  throw new Error(
    "better-auth Cloudflare integration not yet enabled. " +
      "Install better-auth + better-auth-cloudflare and uncomment the implementation in apps/web/lib/auth.ts",
  );
}

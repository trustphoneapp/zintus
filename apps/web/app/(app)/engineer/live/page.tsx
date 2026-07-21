import EngineerLivePresentation from "@/app/judge/page";

/**
 * Public-facing Engineer presentation inside the ordinary Zintus product shell.
 * The route deliberately reuses the same replay and protected live-session
 * component as the standalone entry so the demonstration never forks product
 * behaviour from the experience users see in the app.
 */
export default function EngineerLivePage() {
  return <EngineerLivePresentation />;
}

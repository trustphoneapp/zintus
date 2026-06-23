import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const RELAY_URL = process.env.NEXT_PUBLIC_RELAY_URL ?? 'https://relay.zintus.ai';

export default async function ReferralPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;

  // Validate the referral code server-side
  let valid = false;
  try {
    const res = await fetch(
      `${RELAY_URL}/api/referral/resolve?code=${encodeURIComponent(code)}`,
      { cache: 'no-store' }
    );
    valid = res.ok;
  } catch {
    valid = false;
  }

  if (!valid) {
    redirect('/pricing');
  }

  // Set referral cookie (30 days, SameSite=Lax)
  const cookieStore = await cookies();
  cookieStore.set('zintus_ref', code, {
    maxAge: 60 * 60 * 24 * 30,
    sameSite: 'lax',
    path: '/',
  });

  redirect(`/pricing?ref=${encodeURIComponent(code)}`);
}

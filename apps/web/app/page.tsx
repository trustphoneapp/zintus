import { CTA } from "@/components/marketing/CTA";
import { FAQ } from "@/components/marketing/FAQ";
import { Features } from "@/components/marketing/Features";
import { Footer } from "@/components/marketing/Footer";
import { Hero } from "@/components/marketing/Hero";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { InstallSection } from "@/components/marketing/InstallSection";
import { MockChatDemo } from "@/components/marketing/MockChatDemo";
import { Navbar } from "@/components/marketing/Navbar";
import { PlatformSection } from "@/components/marketing/PlatformSection";
import { ProviderGrid } from "@/components/marketing/ProviderGrid";
import { Stats } from "@/components/marketing/Stats";
import { TrustBar } from "@/components/marketing/TrustBar";

export default function HomePage() {
  return (
    <main className="marketing-page">
      <Navbar />
      <Hero />
      <TrustBar />
      <MockChatDemo />
      <Stats />
      <HowItWorks />
      <Features />
      <PlatformSection />
      <ProviderGrid />
      <InstallSection />
      <FAQ />
      <CTA />
      <Footer />
    </main>
  );
}

"use client";

import { useEffect } from "react";
import type { ProviderId } from "@multipleai/types";
import { PROVIDERS } from "@/lib/providers";
import { useProviderStatusStore } from "@/lib/store";

export function ProviderRail({
  selectedProvider,
  activeProvider,
  onSelect,
}: {
  selectedProvider: ProviderId | null;
  activeProvider: ProviderId | null;
  onSelect: (id: ProviderId | null) => void;
}) {
  const { providers, unlock } = useProviderStatusStore();

  useEffect(() => {
    void unlock();
  }, [unlock]);

  const highlightId = activeProvider ?? selectedProvider;

  return (
    <div className="provider-rail" role="toolbar" aria-label="Provider status">
      <button
        type="button"
        className={`provider-pill${highlightId == null ? " active" : ""}`}
        onClick={() => onSelect(null)}
      >
        auto
      </button>
      {(providers.length ? providers : PROVIDERS).map((provider) => (
        <button
          key={provider.id}
          type="button"
          className={`provider-pill${highlightId === provider.id ? " active" : ""}`}
          onClick={() => onSelect(provider.id)}
          style={{ borderColor: provider.color }}
        >
          <span className="provider-dot" style={{ background: provider.color }} />
          {provider.id}
        </button>
      ))}
    </div>
  );
}

"use client";

import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

/**
 * Reusable tooltip for icon-only buttons and other controls that need a label
 * on hover/focus. Built on the already-installed @radix-ui/react-tooltip (so it
 * is keyboard- and touch-accessible and handles edge collisions), styled with
 * the @zintus/ui design tokens so it tracks light/dark automatically.
 *
 * The 400ms open delay matches the rest of the app; the trigger uses `asChild`
 * so the child element (e.g. a <button>) keeps its own markup and a11y.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  sideOffset = 6,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
}) {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            sideOffset={sideOffset}
            collisionPadding={8}
            style={{
              background: "var(--color-elevated)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-bright)",
              borderRadius: "6px",
              padding: "4px 8px",
              fontSize: "12px",
              fontWeight: 500,
              lineHeight: 1.4,
              maxWidth: "240px",
              boxShadow: "0 2px 10px rgba(0,0,0,.14)",
              userSelect: "none",
              zIndex: 60,
            }}
          >
            {content}
            <RadixTooltip.Arrow
              width={11}
              height={6}
              style={{ fill: "var(--color-elevated)" }}
            />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}

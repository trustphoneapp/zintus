"use client";

import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

/**
 * Reusable tooltip for icon-only buttons and other controls that need a label
 * on hover/focus. Built on @radix-ui/react-tooltip (keyboard/touch accessible,
 * handles edge collisions), styled inline with the desktop design tokens.
 *
 * NB: this app's Tailwind utilities are not generated (globals.css does not
 * import tailwindcss), so styling is intentionally inline + token vars to match
 * how the rest of the desktop chrome is actually styled.
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
              border: "1px solid var(--color-border)",
              borderRadius: "6px",
              padding: "4px 8px",
              fontSize: "12px",
              fontWeight: 500,
              lineHeight: 1.4,
              maxWidth: "240px",
              boxShadow: "0 2px 10px rgba(0,0,0,.4)",
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

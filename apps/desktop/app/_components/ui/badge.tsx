import * as React from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  style,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border px-2 py-0.5 font-mono text-[10px] font-normal text-text-muted",
        className,
      )}
      style={style}
      {...props}
    />
  );
}

"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Tooltip } from "@/components/ui/Tooltip";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted ? resolvedTheme !== "light" : true;
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";

  return (
    <Tooltip content={label} side="bottom">
      <button
        type="button"
        className="theme-toggle"
        aria-label={label}
        onClick={() => setTheme(isDark ? "light" : "indigo")}
      >
        {isDark ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    </Tooltip>
  );
}

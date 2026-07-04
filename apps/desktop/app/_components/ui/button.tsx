import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

// Variants map to the REAL global classes in globals.css (Light.dc button
// system): default = the unclassed ink primary, `secondary` = bordered raised,
// `ghostbtn` = quiet bordered ghost. Tailwind color classes like bg-purple-mid
// were never registered in a @theme block, so they'd silently do nothing.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 transition-colors focus-visible:outline-none disabled:pointer-events-none",
  {
    variants: {
      variant: {
        default: "",
        secondary: "secondary",
        ghost: "ghostbtn",
      },
      size: {
        default: "",
        sm: "text-xs",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

import { cn } from "@/lib/utils";

export function BrandIcon({ className, decorative = false }: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <img
      src="/antquant.png"
      alt={decorative ? "" : "AntQuant"}
      className={cn("shrink-0 border bg-[#f8f4e8] object-cover", className)}
    />
  );
}

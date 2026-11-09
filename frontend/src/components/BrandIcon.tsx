import { cn } from "@/lib/utils";

export function BrandIcon({ className }: { className: string }) {
  return (
    <span
      aria-hidden
      className={cn("block bg-current [mask:url(/favicon.svg)_center/contain_no-repeat]", className)}
    />
  );
}

import { cn } from "@/lib/utils";

/** The Enzure wordmark (`/logo.svg`, white on the dark ground). */
export function Wordmark({ className }: { className?: string }) {
  return (
    <img
      src="/logo.svg"
      alt="Enzure"
      width={256}
      height={55}
      className={cn("h-3.5 w-auto", className)}
    />
  );
}

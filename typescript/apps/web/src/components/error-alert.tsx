import { AlertCircleIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function ErrorAlert({
  error,
  title = "Something went wrong",
}: {
  error: unknown;
  title?: string;
}) {
  return (
    <Alert variant="destructive">
      <AlertCircleIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="break-words">
        {error instanceof Error ? error.message : String(error)}
      </AlertDescription>
    </Alert>
  );
}

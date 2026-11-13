import { FileTextIcon } from "lucide-react";
import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

/** A text area for a Claim or Evidence, which can also be filled from a text file. */
export function ContentField({
  label,
  description,
  value,
  onChange,
  placeholder,
  disabled,
  rows = 4,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
}) {
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const bytes = new TextEncoder().encode(value).length;
  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => file.current?.click()}
        >
          <FileTextIcon data-icon="inline-start" />
          Load a text file
        </Button>
        <input
          ref={file}
          type="file"
          accept="text/*,.md,.json,.txt"
          className="hidden"
          aria-label={`Load ${label} from a file`}
          onChange={async (event) => {
            const picked = event.target.files?.[0];
            if (picked) onChange(await picked.text());
            event.target.value = "";
          }}
        />
      </div>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        className="min-h-28 font-mono text-sm leading-relaxed"
      />
      <div className="flex justify-between gap-4">
        <FieldDescription>{description}</FieldDescription>
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {bytes.toLocaleString()} bytes
        </span>
      </div>
    </Field>
  );
}

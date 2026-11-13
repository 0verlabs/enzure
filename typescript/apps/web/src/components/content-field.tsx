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
}: {
  label: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  return (
    <Field>
      <div className="flex items-center justify-between">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Button
          type="button"
          variant="ghost"
          size="xs"
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
        className="min-h-28 font-mono text-sm"
      />
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
}

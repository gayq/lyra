import type { RefObject } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

interface EditableFieldProps {
  id: string;
  label: string;
  placeholder: string;
  value?: string;
  fieldRef?: RefObject<HTMLDivElement>;
  onChange?: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
}

export default function EditableField({
  id,
  label,
  placeholder,
  value,
  fieldRef,
  onChange,
  onKeyDown,
}: EditableFieldProps) {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = fieldRef ?? localRef;

  useLayoutEffect(() => {
    const field = ref.current;
    if (field && value !== undefined && field.textContent !== value) {
      field.textContent = value;
    }
  }, [ref, value]);

  return (
    <div
      ref={ref}
      id={id}
      class="editable-field"
      contentEditable="plaintext-only"
      role="textbox"
      aria-label={label}
      aria-multiline="false"
      data-placeholder={placeholder}
      tabIndex={0}
      spellcheck={false}
      onInput={(event) => {
        const field = event.currentTarget;
        if (!field.textContent) field.textContent = "";
        onChange?.(field.textContent ?? "");
      }}
      onKeyDown={(event) => {
        if (event.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          if (event.repeat) return;
        }
        onKeyDown?.(event);
      }}
      onBeforeInput={(event) => {
        const { inputType } = event as InputEvent;
        if (inputType === "insertParagraph" || inputType === "insertLineBreak") {
          event.preventDefault();
        }
      }}
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData?.getData("text/plain") ?? "";
        document.execCommand("insertText", false, text.replace(/[\r\n]/g, ""));
      }}
    />
  );
}

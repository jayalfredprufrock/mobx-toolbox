import { type FC, useEffect, useRef } from "react";

/**
 * Props a selection-control component receives. Kept intentionally minimal so any checkbox — the
 * native input below, a Chakra `Checkbox`, a Tailwind one — can satisfy it.
 */
export interface TableCheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  "aria-label"?: string;
}

/**
 * Zero-config fallback used by `<Table.SelectionCell>` / `<Table.SelectAll>` when the consumer
 * neither registers a `checkbox` on `<Table.Root>` nor passes a render-prop. `indeterminate` is a
 * DOM-only property, so it's applied via ref rather than an attribute.
 */
export const NativeCheckbox: FC<TableCheckboxProps> = ({
  checked,
  indeterminate = false,
  onChange,
  ...rest
}) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} {...rest} />;
};

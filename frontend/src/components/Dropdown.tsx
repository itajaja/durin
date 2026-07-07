import { ReactNode, useEffect, useRef, useState } from "react";

export interface Option {
  value: string;
  label: string;
  /** Optional color dot rendered before the label. */
  color?: string;
}

/** Popover behavior shared by every dropdown: closes on outside click or
 * Escape, and captures printable keys as an invisible type-to-filter query.
 * The query is never displayed — the matched letters light up in the option
 * labels instead (see <Highlight/>).
 *
 * Keys while open: letters/digits append to the query, Backspace deletes,
 * Escape clears the query first and closes on a second press, Enter (with a
 * non-empty query) fires `onEnter` with the query. Keystrokes aimed at real
 * text inputs are left alone.
 */
export function usePopover(
  open: boolean,
  onClose: () => void,
  onEnter?: (query: string) => void
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const queryRef = useRef("");
  const closeRef = useRef(onClose);
  const enterRef = useRef(onEnter);
  closeRef.current = onClose;
  enterRef.current = onEnter;

  useEffect(() => {
    if (!open) {
      queryRef.current = "";
      setQuery("");
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        closeRef.current();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement && t.type !== "checkbox") return;
      if (t instanceof HTMLTextAreaElement || t.isContentEditable) return;
      if (e.key === "Escape") {
        if (queryRef.current) {
          queryRef.current = "";
          setQuery("");
        } else {
          closeRef.current();
        }
      } else if (e.key === "Enter") {
        if (queryRef.current && enterRef.current) {
          e.preventDefault(); // a focused trigger button would re-toggle
          enterRef.current(queryRef.current);
        }
      } else if (e.key === "Backspace") {
        e.preventDefault();
        queryRef.current = queryRef.current.slice(0, -1);
        setQuery(queryRef.current);
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // A leading space keeps its native meaning (activate the focused
        // control); mid-query it types into the filter.
        if (e.key === " " && !queryRef.current) return;
        e.preventDefault();
        queryRef.current += e.key;
        setQuery(queryRef.current);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return { rootRef, query };
}

export function matchesQuery(label: string, query: string): boolean {
  return query === "" || label.toLowerCase().includes(query.toLowerCase());
}

export function filterOptions<T extends Option>(options: T[], query: string): T[] {
  return options.filter((o) => matchesQuery(o.label, query));
}

/** An option label with the letters matched by the (invisible) filter query
 * bolded. */
export function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <b className="msel-hl">{text.slice(idx, idx + query.length)}</b>
      {text.slice(idx + query.length)}
    </>
  );
}

/** The body of a single-pick popover: the options that match the filter
 * query, highlighted, as full-row buttons. */
export function OptionList({
  options,
  query,
  selectedValue,
  onPick,
  children,
}: {
  options: Option[];
  query: string;
  selectedValue?: string | null;
  onPick: (value: string) => void;
  /** Optional extra rows (e.g. a clear/all row) rendered above the options. */
  children?: ReactNode;
}) {
  const shown = filterOptions(options, query);
  return (
    <>
      {children}
      {shown.length === 0 && <div className="msel-empty">No matches</div>}
      {shown.map((o) => (
        <button
          type="button"
          key={o.value}
          className={`msel-opt${o.value === selectedValue ? " msel-opt-selected" : ""}`}
          role="option"
          aria-selected={o.value === selectedValue}
          onClick={() => onPick(o.value)}
        >
          {o.color && <span className="cat-dot" style={{ background: o.color }} />}
          <span className="msel-opt-label">
            <Highlight text={o.label} query={query} />
          </span>
        </button>
      ))}
    </>
  );
}

/** A single-select dropdown styled like the multiselect combobox, with
 * type-to-filter. Enter picks the first match. `value: null` renders the
 * placeholder — useful for action-style pickers (quick ranges). */
export default function Select({
  label,
  value,
  options,
  onChange,
  placeholder = "Pick…",
}: {
  label?: string;
  value: string | null;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  const { rootRef, query } = usePopover(
    open,
    () => setOpen(false),
    (q) => {
      const first = filterOptions(options, q)[0];
      if (first) pick(first.value);
    }
  );
  const current = value !== null ? options.find((o) => o.value === value) : undefined;

  return (
    <div className="msel" ref={rootRef}>
      {label && <span className="msel-label">{label}</span>}
      <button
        type="button"
        className="msel-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="msel-summary">
          {current ? (
            <>
              {current.color && (
                <span className="cat-dot" style={{ background: current.color }} />
              )}
              {current.label}
            </>
          ) : (
            placeholder
          )}
        </span>
        <span className="msel-caret">▾</span>
      </button>
      {open && (
        <div className="msel-pop" role="listbox">
          <OptionList options={options} query={query} selectedValue={value} onPick={pick} />
        </div>
      )}
    </div>
  );
}

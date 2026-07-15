import { ReactNode, useEffect, useRef, useState } from "react";
import { copyText, CsvRow, toCsvText } from "../csv";

/** A table whose rows render and serialize from the same data: every row
 * in `data` goes through both `renderRow` (the JSX) and `toCsv` (its CSV
 * cells), so the copy button always copies exactly what the table shows —
 * the two views cannot drift apart.
 *
 * The button floats by the table's top-right corner while the header row
 * is hovered; clicking it copies the CSV (header + rows) to the clipboard.
 */
export default function CopyableTable<T>({
  className,
  csvHeader,
  header,
  data,
  toCsv,
  renderRow,
  emptyRow,
  after,
  tfoot,
}: {
  className?: string;
  csvHeader: CsvRow;
  /** The header row(s); also the hover trigger for the copy button. */
  header: ReactNode;
  data: T[];
  toCsv: (row: T, index: number) => CsvRow;
  renderRow: (row: T, index: number) => ReactNode;
  /** Shown in place of the data rows while `data` is empty. */
  emptyRow?: ReactNode;
  /** Extra rows after the data rows (e.g. an infinite-scroll sentinel). */
  after?: ReactNode;
  tfoot?: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const hideTimer = useRef<number>();
  const flashTimer = useRef<number>();
  const [visible, setVisible] = useState(false);
  const [flash, setFlash] = useState<"idle" | "copied" | "failed">("idle");

  // Hover sensing is all native listeners: the button must cancel the hide
  // scheduled by the header's mouseleave, and React's delegated synthetic
  // onMouseEnter proved unreliable for that on this positioned overlay —
  // the native event fires, the synthetic one doesn't always.
  const show = () => {
    window.clearTimeout(hideTimer.current);
    setVisible(true);
  };
  const scheduleHide = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setVisible(false), 400);
  };

  useEffect(() => {
    const thead = wrapRef.current?.querySelector("thead");
    const btn = btnRef.current;
    if (!thead || !btn) return;
    const targets = [thead, btn];
    for (const t of targets) {
      t.addEventListener("mouseenter", show);
      t.addEventListener("mouseleave", scheduleHide);
    }
    return () => {
      for (const t of targets) {
        t.removeEventListener("mouseenter", show);
        t.removeEventListener("mouseleave", scheduleHide);
      }
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(flashTimer.current);
    };
  }, []);

  const onCopy = async () => {
    const ok = await copyText(toCsvText(csvHeader, data.map(toCsv)));
    setFlash(ok ? "copied" : "failed");
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash("idle"), 1400);
  };

  return (
    <div ref={wrapRef} className="csv-wrap">
      <table className={className}>
        <thead>{header}</thead>
        <tbody>
          {data.length === 0 ? emptyRow : data.map(renderRow)}
          {after}
        </tbody>
        {tfoot != null && <tfoot>{tfoot}</tfoot>}
      </table>
      <button
        ref={btnRef}
        type="button"
        className={`csv-copy ${visible ? "is-visible" : ""}`}
        title="Copy table as CSV"
        aria-label="Copy table as CSV"
        onClick={onCopy}
      >
        {flash === "idle" ? "⧉" : flash === "copied" ? "✓" : "✕"}
      </button>
    </div>
  );
}

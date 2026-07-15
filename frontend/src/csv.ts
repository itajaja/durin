/** CSV serialization for tables (see components/CopyableTable.tsx).
 *
 * Cell values favor spreadsheet-friendly forms: ISO dates and plain
 * unformatted numbers rather than the localized strings shown in the UI.
 */

export type CsvRow = string[];

/** Money amounts for CSV cells: computed sums carry float noise
 * (0.1 + 0.2…), so round to cents. Exact strings pass through Number()
 * unchanged in value. */
export function csvAmount(v: string | number): string {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : String(v);
}

/** Quote a field only when RFC 4180 requires it. */
function escapeField(field: string): string {
  return /[",\n\r]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

export function toCsvText(header: CsvRow, rows: CsvRow[]): string {
  return [header, ...rows].map((row) => row.map(escapeField).join(",")).join("\n");
}

/** Copy text to the clipboard; falls back to a hidden textarea when the
 * async clipboard API is unavailable (e.g. plain-http dev hosts). */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the textarea path
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

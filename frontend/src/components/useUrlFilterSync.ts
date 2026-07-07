import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";

/** Two-way sync between a page's filter state and the URL query string.
 *
 * State → URL: whenever `deps` change, `makeParams` serializes the state and
 * the result is PUSHED as a new history entry (debounced so a burst of
 * changes — typing a date, quick range setting both ends — lands as one
 * entry). Return null while the state isn't hydrated enough to serialize.
 * The very first write only canonicalizes what the URL already said, so it
 * replaces instead of pushing.
 *
 * URL → state: a query string we didn't write means Back/Forward (or a
 * hand-edited URL) — `applyParams` re-hydrates the filter state from it.
 */
export default function useUrlFilterSync(
  makeParams: () => URLSearchParams | null,
  applyParams: (p: URLSearchParams) => void,
  deps: unknown[]
) {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlStr = searchParams.toString();
  const lastWritten = useRef(urlStr);
  const bootstrapped = useRef(false);
  const applyRef = useRef(applyParams);
  const makeRef = useRef(makeParams);
  const setterRef = useRef(setSearchParams);
  applyRef.current = applyParams;
  makeRef.current = makeParams;
  setterRef.current = setSearchParams;

  useEffect(() => {
    if (urlStr === lastWritten.current) return; // our own write echoing back
    lastWritten.current = urlStr;
    applyRef.current(new URLSearchParams(urlStr));
  }, [urlStr]);

  useEffect(() => {
    const p = makeRef.current();
    if (p === null) return;
    const s = p.toString();
    if (s === lastWritten.current) {
      bootstrapped.current = true;
      return;
    }
    if (!bootstrapped.current) {
      bootstrapped.current = true;
      lastWritten.current = s;
      setterRef.current(p, { replace: true });
      return;
    }
    // The cleanup doubles as the debounce AND cancels a stale pending push
    // when Back/Forward re-hydrates state mid-flight.
    const t = window.setTimeout(() => {
      lastWritten.current = s;
      setterRef.current(p);
    }, 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, formatDate, formatMoney } from "../api";
import {
  CATEGORY_COLORS,
  CategoriesResponse,
  Category,
  PreviewResponse,
  REFRESHED_EVENT,
} from "../types";

function ColorSwatches({
  value,
  onChange,
  legacy,
}: {
  value: string;
  onChange: (color: string) => void;
  legacy?: string;
}) {
  // A category created before the palette existed keeps its color: show it
  // as an extra swatch, anchored to the ORIGINAL color (not the live value)
  // so it stays selectable after trying other swatches.
  const options =
    legacy && !CATEGORY_COLORS.includes(legacy)
      ? [legacy, ...CATEGORY_COLORS]
      : CATEGORY_COLORS;
  return (
    <div className="swatch-grid" role="radiogroup" aria-label="Category color">
      {options.map((c) => (
        <button
          key={c}
          type="button"
          className={`swatch${c === value ? " swatch-selected" : ""}`}
          style={{ background: c }}
          title={c}
          aria-label={`Color ${c}`}
          aria-pressed={c === value}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

export default function CategoriesPage() {
  const [data, setData] = useState<CategoriesResponse | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recatBusy, setRecatBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const resp = await api<CategoriesResponse>("/api/categories");
      if (alive.current) setData(resp);
    } catch (err) {
      if (alive.current) {
        setError(err instanceof Error ? err.message : "Failed to load categories");
      }
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // A top-bar refresh can change counts (new transactions categorized).
  useEffect(() => {
    const onRefreshed = () => load();
    window.addEventListener(REFRESHED_EVENT, onRefreshed);
    return () => window.removeEventListener(REFRESHED_EVENT, onRefreshed);
  }, [load]);

  const flash = (msg: string) => {
    setNotice(msg);
    setError("");
  };

  const recategorizeAll = async () => {
    if (
      !window.confirm(
        "Re-derive every transaction from the current substrings? " +
          "Transactions matching no substring become uncategorized. " +
          "Hand-categorized transactions are not touched."
      )
    ) {
      return;
    }
    setRecatBusy(true);
    setError("");
    try {
      const res = await api<{ changed: number }>("/api/categorize/all", {
        method: "POST",
        body: "{}",
      });
      flash(`Recategorized ${res.changed} transaction${res.changed === 1 ? "" : "s"}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recategorize failed");
    } finally {
      setRecatBusy(false);
    }
  };

  return (
    <div className="page">
      <h2>Categories</h2>
      <p className="muted">
        Transactions start uncategorized. Add substrings to a category and any uncategorized
        transaction whose description, payee, or memo contains one (case-insensitive, first
        match wins) is filed there. Removing a substring never moves transactions;{" "}
        <em>Recategorize</em> on a category re-derives just that category.
      </p>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-ok">{notice}</div>}

      <div className="cat-page-actions">
        <NewCategoryForm
          usedColors={data?.categories.map((c) => c.color) ?? []}
          onCreated={(c) => {
            flash(`Created ${c.name}.`);
            load();
          }}
          onError={setError}
        />
        {data && data.categories.length > 0 && (
          <button className="btn btn-quiet" disabled={recatBusy} onClick={recategorizeAll}>
            {recatBusy ? "Recategorizing…" : "Recategorize all"}
          </button>
        )}
      </div>

      {data && data.categories.length === 0 && (
        <div className="card empty">
          No categories yet — create your first one above. {data.uncategorized_count}{" "}
          transaction{data.uncategorized_count === 1 ? "" : "s"} waiting to be categorized.
        </div>
      )}

      {data &&
        data.categories.map((c) => (
          <CategoryCard
            key={c.id}
            category={c}
            onChanged={(msg) => {
              if (msg) flash(msg);
              load();
            }}
            onError={setError}
          />
        ))}

      {data && data.categories.length > 0 && (
        <p className="muted small">
          {data.uncategorized_count} uncategorized transaction
          {data.uncategorized_count === 1 ? "" : "s"}.
        </p>
      )}
    </div>
  );
}

function NewCategoryForm({
  usedColors,
  onCreated,
  onError,
}: {
  usedColors: string[];
  onCreated: (c: Category) => void;
  onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [color, setColor] = useState(CATEGORY_COLORS[0]);
  const [isTransaction, setIsTransaction] = useState(false);
  const [busy, setBusy] = useState(false);

  const openForm = () => {
    // Default to the first palette color no other category uses; never
    // overwrite a choice the user already made while the form is showing.
    const free = CATEGORY_COLORS.find((c) => !usedColors.includes(c));
    setColor(free ?? CATEGORY_COLORS[usedColors.length % CATEGORY_COLORS.length]);
    setOpen(true);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const created = await api<Category>("/api/categories", {
        method: "POST",
        body: JSON.stringify({ name, emoji, color, is_transaction: isTransaction }),
      });
      setName("");
      setEmoji("");
      setIsTransaction(false);
      setOpen(false);
      onCreated(created);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not create category");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="btn btn-primary" onClick={openForm}>
        New category
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="card cat-form">
      <h3>New category</h3>
      <div className="cat-form-fields">
        <label>
          Name
          <input required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label>
          Emoji
          <input
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            placeholder="🛒"
            className="emoji-input"
          />
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={isTransaction}
            onChange={(e) => setIsTransaction(e.target.checked)}
          />
          Not spending (transfers, card payments…)
        </label>
      </div>
      <div className="swatch-field">
        <span className="swatch-label">Color</span>
        <ColorSwatches value={color} onChange={setColor} />
      </div>
      <div className="edit-actions">
        <div className="spacer" />
        <button type="button" className="btn btn-quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          Create
        </button>
      </div>
    </form>
  );
}

function CategoryCard({
  category,
  onChanged,
  onError,
}: {
  category: Category;
  onChanged: (msg?: string) => void;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const [emoji, setEmoji] = useState(category.emoji);
  const [color, setColor] = useState(category.color);
  const [isTransaction, setIsTransaction] = useState(category.is_transaction);
  const [busy, setBusy] = useState(false);

  const [newSub, setNewSub] = useState("");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const previewSeq = useRef(0);

  // Live preview: which uncategorized transactions would this substring
  // actually file HERE? (Server-side it respects older rules' priority.)
  useEffect(() => {
    // Always invalidate in-flight responses, including when clearing.
    const mySeq = ++previewSeq.current;
    const needle = newSub.trim();
    if (!needle) {
      setPreview(null);
      return;
    }
    const t = window.setTimeout(async () => {
      try {
        const resp = await api<PreviewResponse>(
          `/api/categories/${category.id}/preview?substring=${encodeURIComponent(needle)}`
        );
        if (mySeq === previewSeq.current) setPreview(resp);
      } catch {
        // preview is best-effort
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [newSub, category.id]);

  const saveEdit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/categories/${category.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, emoji, color, is_transaction: isTransaction }),
      });
      setEditing(false);
      onChanged(`Updated ${name}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (
      !window.confirm(
        `Delete "${category.name}"? Its ${category.txn_count} transaction${
          category.txn_count === 1 ? "" : "s"
        } will become uncategorized.`
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api(`/api/categories/${category.id}`, { method: "DELETE" });
      onChanged(`Deleted ${category.name}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Delete failed");
      setBusy(false);
    }
  };

  const recategorize = async () => {
    setBusy(true);
    try {
      const res = await api<{ pulled_in: number; pulled_out: number }>(
        `/api/categories/${category.id}/recategorize`,
        { method: "POST", body: "{}" }
      );
      onChanged(
        `Recategorized ${category.name}: ${res.pulled_in} added, ${res.pulled_out} released.`
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : "Recategorize failed");
    } finally {
      setBusy(false);
    }
  };

  const addRule = async (e: FormEvent) => {
    e.preventDefault();
    const substring = newSub.trim();
    if (!substring) return;
    setBusy(true);
    try {
      const res = await api<{ categorized: number }>(`/api/categories/${category.id}/rules`, {
        method: "POST",
        body: JSON.stringify({ substring }),
      });
      setNewSub("");
      setPreview(null);
      onChanged(
        `Added "${substring}" — categorized ${res.categorized} transaction${
          res.categorized === 1 ? "" : "s"
        }.`
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not add substring");
    } finally {
      setBusy(false);
    }
  };

  const removeRule = async (ruleId: number, substring: string) => {
    setBusy(true);
    try {
      await api(`/api/categories/${category.id}/rules/${ruleId}`, { method: "DELETE" });
      onChanged(`Removed "${substring}" (no transactions were moved).`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not remove substring");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card cat-card">
      {editing ? (
        <form onSubmit={saveEdit}>
          <div className="cat-form-fields">
            <label>
              Name
              <input required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Emoji
              <input
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                className="emoji-input"
              />
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={isTransaction}
                onChange={(e) => setIsTransaction(e.target.checked)}
              />
              Not spending
            </label>
          </div>
          <div className="swatch-field">
            <span className="swatch-label">Color</span>
            <ColorSwatches value={color} onChange={setColor} legacy={category.color} />
          </div>
          <div className="edit-actions">
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={recategorize}>
              Recategorize
            </button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
              Delete
            </button>
            <div className="spacer" />
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setEditing(false);
                setName(category.name);
                setEmoji(category.emoji);
                setColor(category.color);
                setIsTransaction(category.is_transaction);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Save
            </button>
          </div>
        </form>
      ) : (
        <div className="cat-card-head">
          <span className="cat-chip">
            <span className="cat-dot" style={{ background: category.color }} />
            {category.emoji ? `${category.emoji} ` : ""}
            <strong>{category.name}</strong>
          </span>
          <span className="muted small">
            {category.txn_count} transaction{category.txn_count === 1 ? "" : "s"}
          </span>
          {category.is_transaction && <span className="badge">not spending</span>}
          <div className="spacer" />
          <button className="btn btn-quiet btn-small" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
      )}

      <div className="rule-list">
        {category.rules.length === 0 && (
          <span className="muted small">No substrings yet — add one below.</span>
        )}
        {category.rules.map((r) => (
          <span key={r.id} className="rule-chip">
            {r.substring}
            <button
              className="rule-x"
              title="Remove (moves nothing)"
              disabled={busy}
              onClick={() => removeRule(r.id, r.substring)}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <form onSubmit={addRule} className="rule-add">
        <input
          placeholder="Add a substring, e.g. whole foods"
          value={newSub}
          onChange={(e) => setNewSub(e.target.value)}
        />
        <button className="btn btn-primary btn-small" disabled={busy || !newSub.trim()}>
          Add
        </button>
      </form>

      {preview && newSub.trim() && (
        <div className="preview-box">
          {preview.count === 0 ? (
            <span className="muted small">No uncategorized transactions match.</span>
          ) : (
            <>
              <div className="small">
                Will categorize <strong>{preview.count}</strong> uncategorized transaction
                {preview.count === 1 ? "" : "s"}:
              </div>
              <ul className="preview-list">
                {preview.sample.slice(0, 5).map((t) => (
                  <li key={t.id}>
                    <span className="muted">{formatDate(t.posted)}</span> {t.description}{" "}
                    <span className={Number(t.amount_str) < 0 ? "neg" : "pos"}>
                      {formatMoney(t.amount_str, t.currency)}
                    </span>
                  </li>
                ))}
                {preview.count > 5 && (
                  <li className="muted small">…and {preview.count - 5} more</li>
                )}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

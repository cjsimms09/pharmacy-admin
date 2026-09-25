import { DOCUMENT_CATEGORIES } from "@/db/schema";
import { DOCUMENT_CATEGORY_LABEL } from "@/lib/labels";
import { fmt, todayIso } from "@/lib/dates";
import { deleteDocument, uploadDocument } from "@/app/(app)/documents/actions";
import { redirect } from "next/navigation";
import { Field, History } from "./ui";
import { splitSuperseded } from "@/lib/superseded";

type Doc = {
  id: string;
  category: string;
  title: string;
  fileName: string;
  sizeBytes: number;
  effectiveOn: string | null;
  expiresOn: string | null;
  uploadedAt: string;
  notes: string | null;
};

/**
 * Documents, with the ones a newer version has replaced folded away.
 *
 * A vault where last year's expired certificate sits next to this year's is a vault where nobody
 * can tell which is the one in force — and the more diligently the pharmacy keeps its records, the
 * worse that gets. Nothing is deleted and nothing moves; the superseded ones go behind a fold with
 * their count on it.
 *
 * A document that has expired with no replacement is not folded away. That is a gap, and it is the
 * thing somebody opening this list needs to see.
 */
export function DocumentList({ docs, redirectTo, canManage }: { docs: Doc[]; redirectTo: string; canManage: boolean }) {
  if (docs.length === 0) return <p className="text-sm text-ink-3">No documents yet.</p>;
  const split = splitSuperseded(docs, todayIso(), {
    // Two documents are the same thing over time when they are the same kind of record about the
    // same subject. Title is part of the key on purpose: two different agreements in the same
    // category are not versions of each other.
    key: (d) => `${d.category}:${d.title.toLowerCase().replace(/\s*\b(19|20)\d{2}\b\s*/g, " ").trim()}`,
    endsOn: (d) => d.expiresOn ?? null,
  });
  return (
    <div className="overflow-x-auto">
      <Table docs={split.current} redirectTo={redirectTo} canManage={canManage} />
      <History label="Replaced by a newer version" count={split.history.length}>
        <Table docs={split.history} redirectTo={redirectTo} canManage={canManage} />
      </History>
    </div>
  );
}

function Table({ docs, redirectTo, canManage }: { docs: Doc[]; redirectTo: string; canManage: boolean }) {
  if (docs.length === 0) return <p className="text-sm text-ink-3">Nothing here that has not been replaced.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Document</th>
            <th>Category</th>
            <th>Effective</th>
            <th>Expires</th>
            <th>Uploaded</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id}>
              <td>
                <a href={`/files/${d.id}`} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">{d.title}</a>
                <div className="text-xs text-ink-3">{d.fileName} · {(d.sizeBytes / 1024).toFixed(0)} KB</div>
                {d.notes && <div className="text-xs text-ink-2">{d.notes}</div>}
              </td>
              <td className="text-ink-2">{DOCUMENT_CATEGORY_LABEL[d.category as keyof typeof DOCUMENT_CATEGORY_LABEL] ?? d.category}</td>
              <td>{fmt(d.effectiveOn)}</td>
              <td>{fmt(d.expiresOn)}</td>
              <td className="text-ink-3">{d.uploadedAt.slice(0, 10)}</td>
              <td>
                {canManage && (
                  <form
                    action={async () => {
                      "use server";
                      await deleteDocument(d.id, redirectTo);
                      redirect(redirectTo);
                    }}
                  >
                    <button className="text-xs text-crit hover:underline" type="submit">Delete</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UploadForm({
  redirectTo,
  hidden,
  categories,
  defaultCategory,
  compact,
}: {
  redirectTo: string;
  hidden?: Record<string, string>;
  categories?: readonly string[];
  defaultCategory?: string;
  compact?: boolean;
}) {
  const cats = categories ?? DOCUMENT_CATEGORIES;
  return (
    <form
      action={async (fd: FormData) => {
        "use server";
        const r = await uploadDocument(fd);
        redirect(r.ok ? redirectTo : `${redirectTo}${redirectTo.includes("?") ? "&" : "?"}error=${encodeURIComponent(r.error)}`);
      }}
      className={compact ? "grid gap-3 sm:grid-cols-2" : "grid gap-3 sm:grid-cols-3"}
      encType="multipart/form-data"
    >
      <input type="hidden" name="redirectTo" value={redirectTo} />
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <Field label="Title" className="sm:col-span-2">
        <input name="title" className="field" required placeholder="e.g. Pharmacist license 2026–2028" />
      </Field>
      <Field label="Category">
        <select name="category" className="field" defaultValue={defaultCategory ?? cats[0]}>
          {cats.map((c) => (
            <option key={c} value={c}>{DOCUMENT_CATEGORY_LABEL[c as keyof typeof DOCUMENT_CATEGORY_LABEL] ?? c}</option>
          ))}
        </select>
      </Field>
      <Field label="Effective / issued on">
        <input name="effectiveOn" type="date" className="field" />
      </Field>
      <Field label="Expires on">
        <input name="expiresOn" type="date" className="field" />
        <label className="mt-1 flex items-center gap-2 text-xs">
          <input type="checkbox" name="noExpiry" /> This does not expire
        </label>
      </Field>
      <Field label="File" hint="PDF, image, or Word document · up to 20 MB">
        <input name="file" type="file" className="field" required accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.gif,.bmp,.tif,.tiff,.doc,.docx,.rtf,image/*" />
      </Field>
      <Field label="Notes" className="sm:col-span-3">
        <input name="notes" className="field" placeholder="Optional" />
      </Field>
      <div className="sm:col-span-3">
        <button className="btn btn-primary" type="submit">Upload</button>
      </div>
    </form>
  );
}

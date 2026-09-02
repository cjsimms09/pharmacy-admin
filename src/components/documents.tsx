import { DOCUMENT_CATEGORIES } from "@/db/schema";
import { DOCUMENT_CATEGORY_LABEL } from "@/lib/labels";
import { fmt } from "@/lib/dates";
import { deleteDocument, uploadDocument } from "@/app/(app)/documents/actions";
import { redirect } from "next/navigation";
import { Field } from "./ui";

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

export function DocumentList({ docs, redirectTo, canManage }: { docs: Doc[]; redirectTo: string; canManage: boolean }) {
  if (docs.length === 0) return <p className="text-sm text-ink-3">No documents yet.</p>;
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
      </Field>
      <Field label="File" hint="PDF, image, or Word document · up to 20 MB">
        <input name="file" type="file" className="field" required accept=".pdf,.jpg,.jpeg,.png,.heic,.webp,.doc,.docx" />
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

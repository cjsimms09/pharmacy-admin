import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { fmt } from "@/lib/dates";
import { PageHeader, BackLink, Notice } from "@/components/ui";
import { DocumentList, UploadForm } from "@/components/documents";
import { InventoryForm } from "../inventory-form";
import { deleteInventory, updateInventory } from "../actions";

export default async function InventoryDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requireManager();
  const { id } = await params;
  const { error, saved } = await searchParams;
  const inv = await db.query.csInventories.findFirst({ where: eq(schema.csInventories.id, id) });
  if (!inv) notFound();
  const [people, docs] = await Promise.all([
    db.query.people.findMany({ orderBy: (p, { asc }) => [asc(p.lastName)] }),
    db.query.documents.findMany({ where: eq(schema.documents.csInventoryId, id) }),
  ]);
  const here = `/inventory/${id}`;
  return (
    <>
      <BackLink href="/inventory">CS inventories</BackLink>
      <PageHeader title={`Inventory of ${fmt(inv.inventoryDate)}`} actions={<Link href={`${here}/print`} className="btn btn-primary">Print C-250 cover sheet</Link>} />
      {error && <Notice kind="crit">{error}</Notice>}
      {saved && <Notice>Saved.</Notice>}
      <section className="card mb-6 max-w-4xl">
        <InventoryForm action={updateInventory.bind(null, id)} people={people} inv={inv} participantIds={JSON.parse(inv.participantIds || "[]")} submitLabel="Save changes" />
      </section>
      <section className="card max-w-4xl">
        <h2 className="mb-3 font-semibold">Signed count and cover sheet</h2>
        <p className="mb-3 text-xs text-ink-3">Attach the signed C-250 and the count sheets (CII kept separately from CIII–V). Retained five years at the pharmacy.</p>
        <DocumentList docs={docs} redirectTo={here} canManage />
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-accent">Upload</summary>
          <div className="mt-3"><UploadForm redirectTo={here} hidden={{ csInventoryId: id }} categories={["cs_inventory", "other"]} defaultCategory="cs_inventory" compact /></div>
        </details>
      </section>
      <form action={deleteInventory.bind(null, id)} className="mt-6"><button className="btn btn-danger">Delete inventory record</button></form>
    </>
  );
}

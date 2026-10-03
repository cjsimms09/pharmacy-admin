import { db } from "@/db";
import { requireManager } from "@/lib/auth";
import { PageHeader, BackLink, Notice } from "@/components/ui";
import { IncidentForm } from "../../incident-form";
import { createIncident } from "../../actions";

export const metadata = { title: "Log incident" };

export default async function NewIncidentPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireManager();
  const { error } = await searchParams;
  const people = await db.query.people.findMany({ orderBy: (p, { asc }) => [asc(p.lastName)] });
  return (
    <>
      <BackLink href="/cqi/incidents">Incidents</BackLink>
      <PageHeader title="Log incident" subtitle="Record it the day it happens; the review can be filled in over the following days." />
      {error && <Notice kind="crit">{error}</Notice>}
      <div className="max-w-4xl"><IncidentForm action={createIncident} people={people} submitLabel="Save incident" /></div>
    </>
  );
}

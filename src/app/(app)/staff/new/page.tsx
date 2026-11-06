import { requireManager } from "@/lib/auth";
import { PageHeader, BackLink, Notice } from "@/components/ui";
import { PersonForm } from "../person-form";
import { createPerson } from "../actions";

export const metadata = { title: "Add staff member" };

export default async function NewPersonPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireManager();
  const { error } = await searchParams;
  return (
    <>
      <BackLink href="/staff">Staff</BackLink>
      <PageHeader title="Add staff member" subtitle="Licenses, CPR, and training are added on the next screen." />
      {error && <Notice kind="crit">{error}</Notice>}
      <div className="card max-w-2xl">
        <PersonForm action={createPerson} submitLabel="Create" />
      </div>
    </>
  );
}

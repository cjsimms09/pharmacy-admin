import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { fmt } from "@/lib/dates";
import { employeeReviewsOf, rxNumbersOf } from "@/lib/cqi";
import { PrintFrame } from "@/components/print";
import { C650Body } from "@/components/c650-form";
import { audit } from "@/lib/audit";

export const metadata = { title: "C-650" };

/** Kansas Form C-650: CQI Incident Report Evaluation. The layout is in components/c650-form.tsx. */
export default async function IncidentPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireManager();
  const { id } = await params;
  const inc = await db.query.cqiIncidents.findFirst({ where: eq(schema.cqiIncidents.id, id) });
  if (!inc) notFound();
  const [s, people, creds] = await Promise.all([getSettings(), db.query.people.findMany(), db.query.credentials.findMany()]);
  await audit({ action: "cqi.incident.print", userId: user.id, userName: user.name, entity: "cqi_incident", entityId: id });
  const name = (pid: string | null) => {
    const p = people.find((x) => x.id === pid);
    return p ? `${p.firstName} ${p.lastName}` : "";
  };
  const licenseOf = (pid: string) => creds.find((c) => c.personId === pid && ["pharmacist_license", "technician_registration", "intern_registration"].includes(c.type))?.number ?? "";
  const rows = [...employeeReviewsOf(inc)];
  while (rows.length < 6) rows.push({ personId: "", reviewedOn: null, reviewedByPersonId: null });
  const pso = s.pso_member === "yes";

  return (
    <PrintFrame formTitle="CQI Incident Report Evaluation" formNumber="Form C-650" revised="1/2025" backHref={`/cqi/incidents/${id}`}>
      <C650Body
        d={{
          facility: s.pharmacy_name,
          registration: s.pharmacy_registration_number,
          rx: rxNumbersOf(inc).join(", "),
          createdOn: fmt(inc.reportCreatedOn),
          type: inc.type,
          typeOther: inc.typeOther ?? "",
          reviewStartedOn: fmt(inc.reviewStartedOn),
          reviewer: name(inc.reviewerPersonId),
          people: rows.map((r) => ({
            name: name(r.personId || null),
            license: r.personId ? licenseOf(r.personId) : "",
            reviewedOn: r.reviewedOn ? fmt(r.reviewedOn) : "",
            reviewedBy: name(r.reviewedByPersonId),
          })),
          pso,
          psoName: pso ? s.pso_name : "",
          psoExpires: pso ? fmt(s.pso_expires_on) : "",
          picName: name(people.find((p) => p.isPic)?.id ?? null),
          completedOn: fmt(inc.reviewCompletedOn),
          rca: inc.rootCauseAnalysis,
          cap: inc.correctiveActionPlan,
        }}
      />
    </PrintFrame>
  );
}

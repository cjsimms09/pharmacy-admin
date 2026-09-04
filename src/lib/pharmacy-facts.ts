import "server-only";
import { db } from "@/db";
import { getSettings } from "./settings";
import { onSiteToday } from "./roster";

/**
 * What this pharmacy actually is, told to the reviewer.
 *
 * The audit kept returning findings that read "the registration number was not provided to me",
 * "neither the registration number nor the identity of the pharmacist in charge was provided",
 * "the expiration date and the authorized schedules are facts about this pharmacy that were not
 * given to me". Every one of those facts is on file here — on the settings page, on the licences
 * page, against a person on the staff list. They were never passed in.
 *
 * That is the difference between a review that says "decide this and write it yourself" twenty
 * times and one that hands back finished text. The reviewer is under strict instruction never to
 * invent a fact about the pharmacy, which is right; the answer is not to loosen that instruction
 * but to stop withholding the facts.
 *
 * The named roles are the other half. Nine findings across six sections come down to one thing:
 * the manual was inherited from a physician practice and routes everything to a Human Resources
 * Manager, a Chief Administrator, a Department Manager. Nobody here holds those titles. Who
 * actually receives a harassment complaint is not something any system can work out — but it is
 * one answer, given once, that resolves nine findings.
 */

export type NamedRoles = {
  complaints: string;
  complaintsAlt: string;
  hiring: string;
  termination: string;
};

export async function namedRoles(): Promise<NamedRoles> {
  const s = await getSettings();
  return {
    complaints: (s.role_complaints ?? "").trim(),
    complaintsAlt: (s.role_complaints_alt ?? "").trim(),
    hiring: (s.role_hiring ?? "").trim(),
    termination: (s.role_termination ?? "").trim(),
  };
}

export type FactSheet = {
  /** The block handed to the reviewer. */
  text: string;
  /** What is still missing, so the page can say so rather than the audit discovering it. */
  missing: { what: string; why: string; href: string }[];
};

export async function pharmacyFacts(): Promise<FactSheet> {
  const [s, people, credentials, roles] = await Promise.all([
    getSettings(),
    onSiteToday(),
    db.query.credentials.findMany(),
    namedRoles(),
  ]);

  const ours = credentials.filter((c) => !c.personId);
  const held = (type: string) => ours.find((c) => c.type === type) ?? null;
  const missing: FactSheet["missing"] = [];
  const lines: string[] = [];

  const name = s.pharmacy_name || "This pharmacy";
  lines.push(`${name}, an independent community pharmacy at ${[s.pharmacy_address, s.pharmacy_city, s.pharmacy_state, s.pharmacy_zip].filter(Boolean).join(", ") || "an address not recorded"}.`);

  // ── The registrations the manual is written for ─────────────────
  const boardNumber = (s.pharmacy_registration_number ?? "").trim() || held("pharmacy_registration")?.number?.trim();
  const boardExpiry = held("pharmacy_registration")?.expiresOn;
  if (boardNumber) {
    lines.push(`Kansas Board of Pharmacy registration ${boardNumber}${boardExpiry ? `, expiring ${boardExpiry}` : ""}.`);
  } else {
    missing.push({
      what: "The Kansas Board of Pharmacy registration number",
      why: "The manual governs dispensing under a registration it cannot name, so the reviewer cannot write the identification block.",
      href: "/settings",
    });
  }

  const deaNumber = (s.pharmacy_dea ?? "").trim() || held("dea_registration")?.number?.trim();
  const deaExpiry = held("dea_registration")?.expiresOn;
  const schedules = (s.dea_schedules ?? "").trim();
  if (deaNumber) {
    lines.push(
      `DEA registration ${deaNumber}${deaExpiry ? `, expiring ${deaExpiry}` : ""}${schedules ? `, covering schedules ${schedules}` : ""}.`,
    );
  }
  if (deaNumber && !deaExpiry) {
    missing.push({
      what: "The expiry date on the DEA registration",
      why: "Every controlled substance provision in the manual depends on that registration being current, and the manual cannot say when it lapses.",
      href: "/licenses",
    });
  }
  if (deaNumber && !schedules) {
    missing.push({
      what: "Which schedules the DEA registration covers",
      why: "The manual's controlled substance sections are written for the schedules actually held.",
      href: "/settings",
    });
  }

  if (s.pharmacy_npi) lines.push(`NPI ${s.pharmacy_npi}.`);
  if (s.pharmacy_ncpdp) lines.push(`NCPDP ${s.pharmacy_ncpdp}.`);
  if (s.pharmacy_phone) lines.push(`Telephone ${s.pharmacy_phone}.`);

  // ── Who is accountable ──────────────────────────────────────────
  const pic = people.find((p) => p.isPic) ?? null;
  if (pic) {
    const licence = credentials.find((c) => c.personId === pic.id && c.type === "pharmacist_license");
    lines.push(
      `The pharmacist in charge is ${pic.firstName} ${pic.lastName}` +
        (licence?.number ? `, Kansas pharmacist licence ${licence.number}` : "") +
        (licence?.expiresOn ? `, expiring ${licence.expiresOn}` : "") +
        ".",
    );
  } else {
    missing.push({
      what: "Who the pharmacist in charge is",
      why: "Kansas registers a pharmacy to a named pharmacist in charge, and the manual should identify the person accountable for it.",
      href: "/staff",
    });
  }

  // ── The shape of the workforce ──────────────────────────────────
  const count = (role: string) => people.filter((p) => p.role === role).length;
  lines.push(
    `Staff: ${count("pharmacist")} pharmacist${count("pharmacist") === 1 ? "" : "s"}, ` +
      `${count("technician")} technician${count("technician") === 1 ? "" : "s"}, ` +
      `${count("intern")} intern${count("intern") === 1 ? "" : "s"}, ${people.length} in total. ` +
      "There is no human resources department, no chief administrator, no department manager and no physician " +
      "on staff — the pharmacy is owner-operated.",
  );

  // ── The roles the inherited manual keeps naming ─────────────────
  /*
   * The single highest-value fact in this whole block.
   *
   * The manual was carried over from a physician practice and routes complaints, hiring and
   * departures to titles that do not exist here. Nine findings across six sections are that one
   * problem. Answered once, they all become writable.
   */
  const roleLines: string[] = [];
  if (roles.complaints) roleLines.push(`Complaints about conduct, harassment or workplace violence are made to: ${roles.complaints}.`);
  if (roles.complaintsAlt) roleLines.push(`Where that person is the subject of the complaint, it is made instead to: ${roles.complaintsAlt}.`);
  if (roles.hiring) roleLines.push(`Hiring paperwork, including Form I-9, is completed and held by: ${roles.hiring}.`);
  if (roles.termination) roleLines.push(`A departure is decided and processed by: ${roles.termination}.`);
  if (roleLines.length > 0) {
    lines.push(
      "Where the manual names a role, use these and no others: " + roleLines.join(" "),
    );
  } else {
    missing.push({
      what: "Who holds the roles the manual keeps naming",
      why:
        "The inherited text routes complaints, hiring and departures to a Human Resources Manager, a Chief Administrator " +
        "and a Department Manager. Nobody here holds those titles, so the reviewer can only tell you to decide it. " +
        "Answering once fixes the same finding in six sections.",
      href: "/manual#facts",
    });
  }

  // ── What the pharmacy does ──────────────────────────────────────
  lines.push(
    "The pharmacy immunizes, performs simple non-sterile non-hazardous compounding only, dispenses controlled " +
      "substances including schedule II, delivers prescriptions by its own driver, and takes pharmacy students on " +
      "rotation. It does not provide medical care to anyone, including its own employees.",
  );

  return { text: lines.join(" "), missing };
}

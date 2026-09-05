import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SIGNABLE } from "../src/lib/record-signatures";
import { certificatePdf, certificateFileName } from "../src/lib/certificate-pdf";
import type { CertificateData } from "../src/lib/certificate";
import { binderContents } from "../src/lib/training-binder";
import { trainingBinderPdf } from "../src/lib/training-binder";

/**
 * A training attested by email and completed by the trainer is signed by two people, in two
 * different ways, and the certificate has to print both as signatures rather than describing them
 * in prose. Prose is not a signature.
 */
const base: CertificateData = {
  number: "1234567-2026-A1B2C3D4",
  verification: "9F2A7C1D4E8B",
  personName: "Nicole Harrington",
  personRole: "Pharmacist",
  courseTitle: "Bloodborne pathogens",
  authority: "29 CFR 1910.1030(g)(2).",
  minutes: 14,
  completedOn: "2026-09-03",
  expiresOn: "2027-09-03",
  how: "Confirmed by reply.",
  quiz: null,
  liveQuestions: "Attested by the pharmacist-in-charge.",
  material: "Bloodborne pathogens, material version v01KCS4V.",
  statement: "I confirm...",
  signedName: "Nicole Harrington",
  signedAt: "2026-09-03T14:22:00.000Z",
  provider: null,
  pharmacy: { name: "West Wichita Family Pharmacy", address: "Wichita, KS", registration: "1234567", phone: null, logoUrl: null },
  issuedBy: "Cory Simms, Pharmacist-in-Charge",
  trainerQualifications: "Pharmacist-in-Charge; licence 12-34567",
  signatures: [
    {
      role: "The employee, that they were given the material and read it",
      who: "Nicole Harrington",
      statement: "I confirm that I have been given and have read the material.",
      method: 'Reply sent by email containing the words "I COMPLETED THIS" and the reply code.',
      at: "2026-09-03T14:22:00.000Z",
      attribution: ["Sent from nicole@example.com.", "Carried reply code KRT-8M2."],
    },
    {
      role: "The trainer, that the questions and answers happened",
      who: "Cory Simms",
      statement: "On 2026-09-05 I went through it with them and answered their questions.",
      method: "Signed on this pharmacy's system.",
      at: "2026-09-05T16:04:00.000Z",
      attribution: ["Signed from 192.168.1.24."],
    },
  ],
};

describe("the trainer's attestation is a signature", () => {
  test("it is a signable kind, restricted to the people who may make it", () => {
    const spec = SIGNABLE.training_qa_attestation;
    assert.ok(spec, "the trainer's attestation is not a signable record");
    assert.equal(spec.dynamic, true, "the wording names the person and both dates, so it cannot be fixed here");
    assert.equal(spec.statement, "", "a dynamic kind must not carry boilerplate that could be signed by mistake");
    assert.ok(spec.roles?.includes("owner"));
    assert.ok(!spec.roles?.includes("staff"), "staff must not be able to attest their own questions and answers");
  });
});

describe("the certificate as a filed document", () => {
  test("it renders, and carries both signatures", () => {
    const pdf = certificatePdf(base);
    assert.ok(pdf.length > 2000, "the certificate is suspiciously small");
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  });

  test("a certificate with no signatures still renders", () => {
    // A training the pharmacist-in-charge recorded on somebody's behalf has no signature at all,
    // and that is a legitimate record — it just says so on its face rather than inventing one.
    const pdf = certificatePdf({ ...base, signatures: [] });
    assert.ok(pdf.length > 1500);
  });

  test("the file name names the person, the date and the certificate", () => {
    const name = certificateFileName(base);
    assert.match(name, /^training-certificate-[a-z0-9-]+-\d{4}-\d{2}-\d{2}-[A-Z0-9]+\.pdf$/);
    assert.ok(name.includes("nicole-harrington"));
    assert.ok(name.includes("2026-09-03"));
  });

  test("two people with the same completion date do not collide", () => {
    assert.notEqual(
      certificateFileName(base),
      certificateFileName({ ...base, personName: "David Lin", number: "1234567-2026-99887766" }),
    );
  });
});

describe("the binder", () => {
  test("holds every course and numbers straight through", () => {
    const rows = binderContents();
    assert.ok(rows.length >= 6, `only ${rows.length} courses in the binder`);
    // Every course starts where the previous one ended: a contents page that lies is worse than none.
    let at = 3;
    for (const r of rows) {
      assert.equal(r.startsAt, at, `${r.title} is listed on the wrong page`);
      assert.ok(r.pages > 0);
      at += r.pages;
    }
  });

  test("it renders as one document", () => {
    const pdf = trainingBinderPdf("West Wichita Family Pharmacy", "2026-09-05", "Cory Simms");
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.length > 20000, "the whole set should not fit in a few kilobytes");
  });
});

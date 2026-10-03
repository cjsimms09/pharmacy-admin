/*
 * Renders the pharmacy's written training courses as a folder of plain, self-contained HTML pages
 * — one per course and an index — so they can be hosted on the pharmacy's public website.
 *
 * Why: the training email's "Start this training" link points at this site, which runs on a
 * computer in the pharmacy and is reachable nowhere else. Until the site has a real address over
 * https, a link to localhost is a link nobody can open and a reason for the message to be filed
 * as junk. The course text already lives in this repository (src/lib/course-material), so it can
 * be hosted anywhere; the attestation stays as it is — the reply code in the email — which works
 * with no link at all.
 *
 * The pages carry no patient information and no pharmacy identifiers beyond the name. The quiz
 * questions are included as a self-check with the answers folded away.
 *
 * Run as:  node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/export-training-site.ts [outDir]
 * Default outDir: ./training-site
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { COURSES } from "../src/lib/courses";
import { TRAINING_LABEL } from "../src/lib/labels";
import type { Course } from "../src/lib/course-material/types";
import type { TrainingType } from "../src/db/schema";

const PHARMACY = "West Wichita Family Pharmacy";

/** The address each course will live at on the public site: stable, lowercase, no dates. */
export const SLUGS: Partial<Record<TrainingType, string>> = {
  hipaa_privacy_security: "hipaa-privacy-security",
  fwa_general_compliance: "fraud-waste-abuse-general-compliance",
  osha_bloodborne: "osha-bloodborne-pathogens",
  osha_hazard_communication: "osha-hazard-communication",
  controlled_substance_diversion: "controlled-substance-diversion",
  cqi_program_review: "cqi-program-review",
  technician_initial_training: "pharmacy-technician-initial-training",
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const STYLE = `
  :root { color-scheme: light; }
  body { margin: 0; background: #f7f6f3; color: #1d1d1b; font: 16px/1.6 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
  header { border-bottom: 1px solid #d9d7d0; padding-bottom: 16px; margin-bottom: 24px; }
  h1 { font-size: 28px; line-height: 1.2; margin: 8px 0; }
  h2 { font-size: 20px; margin: 32px 0 8px; }
  .meta { color: #5e5d58; font-size: 14px; }
  .box { background: #fff; border: 1px solid #d9d7d0; border-radius: 8px; padding: 16px; margin: 16px 0; }
  .takeaways { background: #eef3ea; border-color: #c8d8bf; }
  details { margin: 8px 0; }
  summary { cursor: pointer; font-weight: 600; }
  ol li { margin: 6px 0; }
  a { color: #2f5d8a; }
  .attest { background: #fff7e6; border-color: #ead9b0; }
  @media (prefers-color-scheme: dark) { :root { color-scheme: light; } }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} — ${esc(PHARMACY)} training</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>
`;
}

function coursePage(type: TrainingType, c: Course): string {
  const sections = c.sections
    .map(
      (s) =>
        `<section><h2>${esc(s.heading)}</h2>${s.body.map((p) => `<p>${esc(p)}</p>`).join("")}` +
        (s.takeaways?.length ? `<div class="box takeaways"><strong>Take away</strong><ul>${s.takeaways.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : "") +
        `</section>`,
    )
    .join("");
  const quiz = (c.questions ?? []).length
    ? `<h2>Check yourself</h2><p class="meta">Answer each before opening it. These are the questions the pharmacist-in-charge uses to check the training took.</p>` +
      c.questions
        .map(
          (q, i) =>
            `<div class="box"><p><strong>${i + 1}. ${esc(q.q)}</strong></p><ol type="a">${q.options.map((o) => `<li>${esc(o)}</li>`).join("")}</ol>` +
            `<details><summary>Answer</summary><p>${esc(String.fromCharCode(97 + q.answer))}. ${esc(q.why)}</p></details></div>`,
        )
        .join("")
    : "";
  const body =
    `<header><div class="meta">${esc(PHARMACY)} · staff training</div><h1>${esc(c.title)}</h1>` +
    `<div class="meta">${c.minutes ? `About ${c.minutes} minutes · ` : ""}${esc(TRAINING_LABEL[type])}</div></header>` +
    `<div class="box"><p>${esc(c.intro)}</p></div>` +
    ((c.objectives ?? []).length ? `<h2>What you will be able to do</h2><ul>${(c.objectives ?? []).map((o) => `<li>${esc(o)}</li>`).join("")}</ul>` : "") +
    sections +
    quiz +
    `<div class="box attest"><strong>When you have finished</strong><p>Reply to the training email with the reply code printed in it. That reply is your attestation and is filed with your training record. If the email has gone, ask the pharmacist-in-charge.</p></div>` +
    `<p class="meta">Authority: ${esc(c.authority)}</p><p class="meta">${esc(c.whoMayTeach)}</p>` +
    `<p class="meta"><a href="../">All courses</a></p>`;
  return page(c.title, body);
}

function indexPage(entries: { slug: string; title: string; minutes: number }[]): string {
  const list = entries.map((e) => `<li><a href="./${e.slug}/">${esc(e.title)}</a> <span class="meta">— about ${e.minutes} minutes</span></li>`).join("");
  return page(
    "Staff training",
    `<header><div class="meta">${esc(PHARMACY)}</div><h1>Staff training</h1><div class="meta">The written courses. Each one ends with how to attest that you completed it.</div></header><ul>${list}</ul>`,
  );
}

function main() {
  const out = path.resolve(process.argv[2] ?? "./training-site");
  fs.mkdirSync(out, { recursive: true });
  const entries: { slug: string; title: string; minutes: number }[] = [];
  for (const [type, course] of Object.entries(COURSES) as [TrainingType, Course][]) {
    const slug = SLUGS[type];
    if (!slug || !course) continue;
    const dir = path.join(out, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), coursePage(type, course));
    entries.push({ slug, title: course.title, minutes: course.minutes ?? 0 });
    console.log(`${slug}/index.html  (${course.sections.length} sections, ${course.questions?.length ?? 0} questions)`);
  }
  fs.writeFileSync(path.join(out, "index.html"), indexPage(entries));
  fs.writeFileSync(
    path.join(out, "README.md"),
    `# Staff training pages\n\nRendered from the pharmacy admin site's course text by scripts/export-training-site.ts. Host the folder as-is at https://wwfrx.com/training/ — every page is self-contained, mobile-friendly, and marked noindex. Re-run the script when a course changes.\n\n` +
      entries.map((e) => `- /training/${e.slug}/ — ${e.title}`).join("\n") +
      "\n",
  );
  console.log(`index.html and README.md written to ${out}`);
}

main();

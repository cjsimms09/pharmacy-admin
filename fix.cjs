const fs = require("fs");
const p = "src/lib/plan-proposals.ts";
let s = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const sub = (a, b, what) => { if (!s.includes(a)) throw new Error("not found: " + what); s = s.replace(a, b); };

sub(
  "const COMMERCIAL = /\bcommercial\b|\bgroup\s*health\b|\bemployer\b/i;",
  `const COMMERCIAL = /\bcommercial\b|\bgroup\s*health\b|\bemployer\b/i;

/*
 * A PCN is a code, not prose, and needs its own patterns.
 *
 * The word-boundary tests above are right for "Medicare Part D" in a listing and wrong for
 * "MEDDPRIME" on a claim — real Part D PCNs run the words together: MEDDPRIME, MEDDADV, KSPARTD.
 * Matching prose rules against a code silently recognised none of them, which is the whole
 * population this was meant to reach.
 */
const MEDICARE_PCN = /medd|partd|\bpdp\b|\bmapd\b/i;
const MEDICAID_PCN = /medicaid|kscaid|\bmcd\b/i;`,
  "pcn patterns",
);

sub(
  `  if (has(e.pcn, MEDICARE) || has(names, MEDICARE)) {
    const where = has(e.pcn, MEDICARE) ? \`the PCN "\${e.pcn}"\` : \`the payer name "\${names.trim()}"\`;
    return { classification: "medicare", from: \`\${where} names Medicare Part D on the claim itself.\` };
  }
  if (has(e.pcn, MEDICAID) || has(names, MEDICAID)) {
    const where = has(e.pcn, MEDICAID) ? \`the PCN "\${e.pcn}"\` : \`the payer name "\${names.trim()}"\`;
    return { classification: "medicaid", from: \`\${where} names Medicaid on the claim itself.\` };
  }`,
  `  if (has(e.pcn, MEDICAID_PCN) || has(names, MEDICAID)) {
    const where = has(e.pcn, MEDICAID_PCN) ? \`The PCN "\${e.pcn}"\` : \`The payer name "\${names.trim()}"\`;
    return { classification: "medicaid", from: \`\${where} names Medicaid on the claim itself.\` };
  }
  if (has(e.pcn, MEDICARE_PCN) || has(names, MEDICARE)) {
    const where = has(e.pcn, MEDICARE_PCN) ? \`The PCN "\${e.pcn}"\` : \`The payer name "\${names.trim()}"\`;
    return { classification: "medicare", from: \`\${where} names Medicare Part D on the claim itself.\` };
  }`,
  "pcn branches",
);

fs.writeFileSync(p, s.replace(/\n/g, "\r\n"));
console.log("pcn patterns added");

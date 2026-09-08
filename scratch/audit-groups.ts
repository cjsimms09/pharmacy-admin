import { groupKey, groupProducts } from "../src/lib/product-groups";

const show = (label: string, src: Parameters<typeof groupKey>[0]) =>
  console.log(`  ${label.padEnd(46)} ${groupKey(src) ?? "(no key — falls out)"}`);

console.log("An FDA-keyed NDC WITH a NADAC row:");
show("brand, generic class B, EA", { ndc11: "1", equivalenceKey: "amlodipine-10-tab-oral", description: "NORVASC 10MG TAB", classification: "B", pricingUnit: "EA" });
show("generic, class G, EA", { ndc11: "2", equivalenceKey: "amlodipine-10-tab-oral", description: "AMLODIPINE 10MG TAB", classification: "G", pricingUnit: "EA" });

console.log("\nThe same two NDCs with NO NADAC row (no classification, no pricing unit):");
show("brand, no NADAC", { ndc11: "3", equivalenceKey: "amlodipine-10-tab-oral", description: null, classification: null, pricingUnit: null });
show("generic, no NADAC", { ndc11: "4", equivalenceKey: "amlodipine-10-tab-oral", description: null, classification: null, pricingUnit: null });

const rows = [
  { ndc11: "brandWithNadac", equivalenceKey: "amlodipine-10-tab-oral", description: "NORVASC 10MG TAB", classification: "B", pricingUnit: "EA" },
  { ndc11: "genericWithNadac", equivalenceKey: "amlodipine-10-tab-oral", description: "AMLODIPINE 10MG TAB", classification: "G", pricingUnit: "EA" },
  { ndc11: "brandNoNadac", equivalenceKey: "amlodipine-10-tab-oral", description: null, classification: null, pricingUnit: null },
  { ndc11: "genericNoNadac", equivalenceKey: "amlodipine-10-tab-oral", description: null, classification: null, pricingUnit: null },
];
console.log("\nGroups formed from all four:");
for (const [k, list] of groupProducts(rows)) console.log(`  ${k.padEnd(40)} ${list.join(", ")}`);

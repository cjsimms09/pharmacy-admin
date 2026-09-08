const fs = require("fs");
const p = "src/lib/on-hand.ts";
let s = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

// Find the continuation block and the furniture line, and swap their order.
const contStart = s.indexOf("    /*\n     * A row that wrapped");
const contEnd = s.indexOf("    if (/^(page \d|printed on|total|grand total)/i.test(line.trim())) continue;");
if (contStart < 0 || contEnd < 0 || contEnd < contStart) throw new Error("blocks not found");
const contBlock = s.slice(contStart, contEnd);
const furniture = "    if (/^(page \d|printed on|total|grand total|drug file print|\d{1,2}\/\d{1,2}\/\d{4}\s*,\s*page )/i.test(line.trim())) continue;\n";
s = s.slice(0, contStart) + furniture + contBlock + s.slice(contEnd + "    if (/^(page \d|printed on|total|grand total)/i.test(line.trim())) continue;\n".length);

fs.writeFileSync(p, s.replace(/\n/g, "\r\n"));
console.log("furniture judged before continuations");

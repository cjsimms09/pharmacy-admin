import { COURSES } from "./src/lib/courses";
import { packetPdf, packetPdfFileName } from "./src/lib/course-packet";
for (const [k, c] of Object.entries(COURSES)) {
  if (!c) continue;
  const b = packetPdf(c, "West Wichita Family Pharmacy");
  console.log(k, packetPdfFileName(c), (b.byteLength / 1024).toFixed(0) + "kb");
}

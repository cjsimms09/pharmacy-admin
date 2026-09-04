import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyInvoiceText } from "../src/lib/invoices";

/**
 * Reading the schedule the wholesaler already printed.
 *
 * These lines are in the shape a McKesson invoice actually prints — the pharmacy's own three
 * sample invoices were used to get the columns right, and the item classes here are the ones
 * those invoices carried: R against ordinary legend drugs, X against every Schedule II, and B, D
 * or E against the Schedule III to V lines. Drug names and numbers are invented; the layout is
 * not.
 *
 * The point of doing this with a rule rather than a model is that the answer is the same every
 * time and can be pinned here. The point of the tests is the asymmetry: the only outcome that
 * actually matters is that a Schedule II invoice is never filed as anything else.
 */

const head = [
  "Billing No.:7656147106",
  "Billing Date:09/04/2026",
  "Invoice",
  "MCKESSON CORPORATION DC#8165Phone:  855/625-7385",
  "AWP ORRUNITIEXTENDED   H",
  "NDC/UPC/UDI#ITEM#DEL DOC#QTYUM    ITEM DESCRIPTIONRETAIL XPRICEDAMOUNT   M",
].join("\n");

const line = (ndc: string, desc: string, awp: string, cls: string) =>
  `${ndc}257-9894973485930            1 EA ${desc}      ${awp} ${cls}      739.11        739.11 `;

const invoice = (...lines: string[]) => [head, ...lines, "SUMMARY"].join("\n");

describe("an invoice with no controlled substances", () => {
  const text = invoice(
    line("00002-1436-11", "EMGALITY INJ PEN 120MG/ML 1", "916.73", "R"),
    line("24208-0463-25", "LATANOPROST OPH.005% B&L2.5ML@", "24.38", "R"),
    line("00169-6339-10", "NOVOLOG F/PEN PREF SYR 3ML   5", "167.65", "R"),
  );

  test("is filed as ordinary business records", () => {
    const v = classifyInvoiceText(text);
    assert.equal(v.schedule, "none");
    assert.equal(v.confident, true);
  });

  test("and its supplier, number and date are read off it", () => {
    const v = classifyInvoiceText(text);
    assert.match(v.supplier ?? "", /MCKESSON/i);
    assert.equal(v.invoiceNumber, "7656147106");
    assert.equal(v.invoiceDate, "2026-09-04");
  });
});

describe("an invoice carrying Schedule III to V only", () => {
  const text = invoice(
    line("00228-2031-96", "ALPRAZOL TAB 1MG    ACTA 1000@", "1,079.00", "D"),
    line("62756-0970-83", "BUPRE+NAL HCI DISU 8/2MGSUN30@", "312.64", "B"),
    line("69238-1312-09", "PREGABALIN CP 75MG AMN 90@", "758.47", "E"),
    line("00002-1436-11", "EMGALITY INJ PEN 120MG/ML 1", "916.73", "R"),
  );

  test("is filed apart, but not with the Schedule IIs", () => {
    const v = classifyInvoiceText(text);
    assert.equal(v.schedule, "schedule_3_5");
    assert.equal(v.confident, true);
  });

  test("and lists the controlled lines, so nobody has to reopen the PDF", () => {
    const v = classifyInvoiceText(text);
    assert.equal(v.controlledItems.length, 3);
    assert.match(v.controlledItems.join(" "), /ALPRAZOL/);
    assert.ok(!v.controlledItems.join(" ").includes("EMGALITY"));
  });
});

describe("an invoice carrying a Schedule II line", () => {
  const text = invoice(
    line("70010-0029-01", "AMPHET MIX SLT ERCP5MGGRAN100@", "720.00", "X"),
    line("00406-0522-01", "OXYCOD+ACE TB 7.5/325 SGX 100@", "271.54", "X"),
  );

  test("goes to the Schedule II records", () => {
    const v = classifyInvoiceText(text);
    assert.equal(v.schedule, "schedule_2");
    assert.equal(v.confident, true);
  });

  test("one Schedule II line among many is still a Schedule II invoice", () => {
    const mixed = invoice(
      line("00002-1436-11", "EMGALITY INJ PEN 120MG/ML 1", "916.73", "R"),
      line("00228-2031-96", "ALPRAZOL TAB 1MG    ACTA 1000@", "1,079.00", "D"),
      line("00406-0522-01", "OXYCOD+ACE TB 7.5/325 SGX 100@", "271.54", "X"),
    );
    assert.equal(classifyInvoiceText(mixed).schedule, "schedule_2");
  });
});

describe("everything the rule refuses to decide", () => {
  test("an item class it does not recognise is never read as uncontrolled", () => {
    const v = classifyInvoiceText(invoice(line("00002-1436-11", "SOMETHING NEW 10MG", "916.73", "Q")));
    assert.equal(v.schedule, "unknown");
    assert.equal(v.confident, false);
  });

  test("a document with no readable item lines is unknown, not empty", () => {
    const v = classifyInvoiceText("a scanned page with nothing on it that parses");
    assert.equal(v.schedule, "unknown");
    assert.equal(v.confident, false);
  });

  test("a CSOS order number with nothing marked controlled is a disagreement, and goes to a person", () => {
    const text = invoice(
      line("00002-1436-11", "EMGALITY INJ PEN 120MG/ML 1", "916.73", "R"),
      "CSOS ID - 26X100208                         ",
    );
    const v = classifyInvoiceText(text);
    assert.equal(v.schedule, "unknown");
    assert.equal(v.confident, false);
    assert.match(v.basis, /CSOS/);
  });
});

/**
 * A second wholesaler, printing the schedule outright.
 *
 * Independent Pharmacy Distributor puts "C-2" in a DEA column beside each product rather than a
 * one-letter item class. That is plainer than the class codes, and the site reads it — but only
 * in the direction that is safe, because the site has seen very few of these.
 */
describe("an invoice that names the schedule in its own column", () => {
  const ipd = (...marks: string[]) =>
    [
      "Independent Pharmacy Distributor, LLC",
      "Invoice",
      " 1004797",
      "Ship Date: 08/31/2026",
      "Ship CII Subtotal:QuantityPrice",
      ...marks,
      "Page 1 of 3",
    ].join("\n");

  test("a C-2 marking files it with the Schedule II records", () => {
    const v = classifyInvoiceText(ipd("ADZENYS XR 9.4MG   C-2 (P)"));
    assert.equal(v.schedule, "schedule_2");
    assert.equal(v.confident, true);
  });

  test("its supplier, number and date are read off it too", () => {
    const v = classifyInvoiceText(ipd("ADZENYS XR 9.4MG   C-2 (P)"));
    assert.match(v.supplier ?? "", /Independent Pharmacy Distributor/i);
    assert.equal(v.invoiceNumber, "1004797");
    assert.equal(v.invoiceDate, "2026-08-31");
  });

  test("C-3 to C-5 markings, with no C-2 anywhere, go to the Schedule III-V records", () => {
    const v = classifyInvoiceText(ipd("LORAZEPAM 1MG   C-4 (P)"));
    assert.equal(v.schedule, "schedule_3_5");
    assert.equal(v.confident, true);
  });

  test("the CII column heading is not read as a marking, or every invoice would be Schedule II", () => {
    // The heading prints on every one of this supplier's invoices, controlled or not.
    const v = classifyInvoiceText(ipd("AMOXICILLIN 500MG"));
    assert.notEqual(v.schedule, "schedule_2");
  });

  test("no marking at all is unknown, not uncontrolled — the layout is too new to conclude from silence", () => {
    const v = classifyInvoiceText(ipd("AMOXICILLIN 500MG"));
    assert.equal(v.schedule, "unknown");
    assert.equal(v.confident, false);
  });
});

/**
 * A third wholesaler, printing no schedule anywhere.
 *
 * Independent Pharmacy Cooperative's only code column means taxed, net priced or web special —
 * nothing about controlled substances. So their item names are read instead. Weaker than a
 * supplier's own marking, and used only where there is no marking to use.
 */
describe("an invoice with no schedule column at all", () => {
  const ipc = (...items: string[]) =>
    [
      "Independent Pharmacy Cooperative",
      "Invoice Num:11488865",
      "Invoice Date:9/3/2026",
      "INVOICE",
      "6927156",
      "Order Num:",
      "     Nbr       NDCWACAWPCdQtyQty     Price     Amount",
      ...items,
      "t = Taxed Itemn = Net Priced Genericw = Web Special",
    ].join("\n");

  const plain = [
    "5128541Amoxicillin/Clav Pot Tabs 500/125mg Auro 65862050220$8.80$75.6911$2.91$2.91",
    "5173208Benazepril Hcl Tabs 20mg Solc 43547033710$12.00$105.0011$3.96$3.96",
    "5308259Fluoxetine Tabs 60mg Sci 50228063830$9.75$313.2511$2.34$2.34",
    "5149950Ondansetron ODT 8mg Auro 65862039110$25.35$1,113.9511$2.86$2.86",
  ];

  test("a page of ordinary generics is filed as ordinary business records", () => {
    const v = classifyInvoiceText(ipc(...plain));
    assert.equal(v.schedule, "none");
    assert.equal(v.confident, true);
  });

  test("the invoice number is the invoice number, not the order number printed under the word", () => {
    // Their header reads "INVOICE" with the order number beneath it and "Invoice Num:" above.
    assert.equal(classifyInvoiceText(ipc(...plain)).invoiceNumber, "11488865");
  });

  test("supplier and date come off it, including a date written without leading zeros", () => {
    const v = classifyInvoiceText(ipc(...plain));
    assert.match(v.supplier ?? "", /Independent Pharmacy Cooperative/i);
    assert.equal(v.invoiceDate, "2026-09-03");
  });

  test("a controlled line on one of their invoices is still caught", () => {
    const v = classifyInvoiceText(
      ipc(...plain, "5300001Alprazolam Tabs 1mg Acta 10059746017710$20.00$100.0011$4.00$4.00"),
    );
    assert.equal(v.schedule, "schedule_3_5");
  });

  test("and a Schedule II from a supplier who supposedly sends none is caught too", () => {
    const v = classifyInvoiceText(
      ipc(...plain, "5300002Oxycodone/APAP Tabs 5/325mg Cam 10000406051201$30.00$200.0011$8.00$8.00"),
    );
    assert.equal(v.schedule, "schedule_2");
    assert.equal(v.confident, true);
  });

  test("too few readable lines is not enough to conclude anything", () => {
    const v = classifyInvoiceText(ipc(plain[0]));
    assert.equal(v.schedule, "unknown");
    assert.equal(v.confident, false);
  });
});

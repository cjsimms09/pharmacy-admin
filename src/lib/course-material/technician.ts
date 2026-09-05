import type { Course } from "./types";

/**
 * The pharmacy's own technician training course.
 *
 * This one is different from the other six in a way worth stating plainly. The others are annual
 * refreshers on subjects a rule requires be covered. This is the course K.A.R. 68-5-15 requires
 * the pharmacist-in-charge to *have* — "a current pharmacy technician training course, designed
 * for the functioning of that pharmacy" — and it lists, at (b)(1) through (b)(7), the seven areas
 * it has to address. A technician may not perform any task authorised by the pharmacy act until
 * they have completed it, and no later than 180 days from the day they started.
 *
 * So the sections below are laid out against those seven paragraphs, in order, and the mapping is
 * written on each heading rather than left for somebody to reconstruct in front of an inspector.
 * The content is this pharmacy's own training packet — its shelf sections, its filing drawers, its
 * refrigerator policy — because a generic technician course does not satisfy a regulation whose
 * words are "designed for the functioning of that pharmacy".
 *
 * Two obligations attach to the course rather than to the person, and both are tracked as pharmacy
 * obligations rather than buried here: the course is reviewed annually (68-5-15(d)(1)), and the
 * Board is notified of a new technician within 30 days (68-5-15(d)(3)).
 */
export const technician: Course = {
  type: "technician_initial_training",
  title: "Pharmacy technician training",
  authority:
    "K.A.R. 68-5-15 — the pharmacist-in-charge must maintain a current pharmacy technician training course " +
    "designed for the functioning of this pharmacy, addressing the seven areas at (b)(1)–(b)(7), completed within " +
    "180 days of the technician's employment.",
  whoMayTeach:
    "K.A.R. 68-5-15 places the duty on the pharmacist-in-charge: he must ensure the course exists, is designed for " +
    "this pharmacy, is reviewed annually, and that each technician completes it. No credential is specified for " +
    "whoever delivers it and no outside provider can satisfy it, because the regulation requires a course designed " +
    "for the functioning of this pharmacy. This is not continuing education and does not count toward one.",
  intro:
    "This is the training course for pharmacy technicians at this pharmacy. Kansas requires it, requires it to be " +
    "written for this pharmacy specifically rather than bought off a shelf, and requires you to have completed it " +
    "within 180 days of starting here — before which you may not perform tasks the pharmacy act authorises a " +
    "technician to perform. Take your time with it. Most of it is how this pharmacy actually works, and the parts " +
    "that are law are the parts that decide what you are and are not allowed to do.",
  objectives: [
    "Describe the practice of pharmacy and where a technician's work sits inside it.",
    "Find your way around this pharmacy: the five shelf sections, the stations, and what happens at each.",
    "State what a technician may do here and, more importantly, the five things a technician may never do.",
    "Name the federal laws that shape the work, and which agency enforces which.",
    "Read and write the abbreviations, dosage forms and routes used on prescriptions here.",
    "Carry out the calculations the job needs: conversions, concentrations, alligation and days supply.",
    "Store drugs correctly, act on a recall, and file prescriptions and records for the periods Kansas requires.",
    "Follow this pharmacy's compounding, packaging and labelling procedures.",
  ],
  seeAlso: [
    "This pharmacy's policy and procedure manual — the record keeping, compounding and recall chapters are the source for sections 7 to 9 below.",
    "The Drug Recall Checklist Form, at the back of the policy and procedure manual.",
    "The temperature logs on this site, under Temperatures.",
  ],
  references: [
    "K.A.R. 68-5-15 — pharmacy technician training course requirements.",
    "K.S.A. 65-1626 and 65-1663 — definitions and the practice of pharmacy in Kansas.",
    "21 CFR 1304.04 — record retention and separate filing of controlled substance records.",
    "USP <795> and USP <800> — non-sterile compounding and handling hazardous drugs.",
    "21 CFR 1306 — requirements for controlled substance prescriptions.",
  ],
  sections: [
    {
      heading: "The practice of pharmacy, and where you sit in it — 68-5-15(b)(1)",
      body: [
        "The practice of pharmacy is the interpretation, evaluation and implementation of medical orders; the dispensing of prescription drug orders; participation in drug and device selection; drug regimen review; the provision of patient counselling and of the acts or services necessary to provide pharmaceutical care in all areas of patient care, including primary care and collaborative practice; responsibility for the compounding and labelling of drugs and devices; the proper and safe storage of drugs and devices; and the maintenance of proper records.",
        "Read that list again and notice what is in it: interpretation, evaluation, counselling, and responsibility. Those are the pharmacist's. Everything a technician does is a task the pharmacist has delegated and for which the pharmacist remains answerable.",
        "Pharmacy is practised in several settings — community and retail, hospital, long-term care, mail order and specialty, compounding, and nuclear pharmacy. This is an independent community pharmacy: dispensing, immunising, delivering, and knowing the patients by name. The pace, the direct patient contact and the fact that there is nobody else to hand a problem to are what make it different from the others.",
      ],
      takeaways: [
        "Interpretation, evaluation and counselling belong to the pharmacist.",
        "Everything you do is delegated, and the pharmacist remains responsible for it.",
        "This is an independent community pharmacy — direct patient contact, no back office.",
      ],
    },
    {
      heading: "The layout of this pharmacy — 68-5-15(b)(1)",
      body: [
        "Order entry. New patients are added, allergies and health conditions are obtained, and new prescriptions are scanned in to be typed.",
        "Filling station. Leaflets and labels print here, the product is scanned for verification, and the prescription is packaged with its label and presented to the pharmacist.",
        "The Rx shelves. Prescription stock is organised into five sections by storage requirement, use and packaging. Liquids and reconstitutables — all liquids, eye and ear drops, injections. Unit of use — birth control. Alpha — the largest section, all capsules and tablets in alphabetical order. Topicals — creams, ointments and breathing treatments including inhalers and nebulisers. Refrigerator — everything requiring refrigeration, including insulin and vaccines.",
        "Pharmacist station. The final check: that the prescription was filled, packaged and labelled correctly. The prescription is then bagged and put into will-call.",
        "Point of sale. Prescriptions and retail items are sold. Always verify the right prescription is going to the right patient by ALWAYS confirming either the address or the date of birth.",
        "Retail products. Over-the-counter medicines organised by drug class and use: antihistamines, NSAIDs, cough suppressants, eye drops, vitamins, steroid creams and so on.",
        "The tour of the pharmacy is part of this training and is done with the pharmacist-in-charge. Reading this is not a substitute for walking it.",
      ],
      takeaways: [
        "Five shelf sections: liquids/reconstitutables, unit of use, alpha, topicals, refrigerator.",
        "At point of sale, verify address or date of birth. Always. Every time.",
        "The final check is the pharmacist's station and nobody else's.",
      ],
    },
    {
      heading: "What a technician does here, and what a technician may never do — 68-5-15(b)(2)",
      body: [
        "Pharmacy technicians work under the direct supervision of a licensed pharmacist and perform the duties the pharmacist designates. You must understand the standards, ethics, laws and regulations that govern the practice of pharmacy — which is why the next section exists.",
        "Your duties here: obtain new patient information including allergies, health conditions and identification; type prescriptions that are scanned in; calculate days supply from the quantity and directions; count and fill medications; prepackage and properly label; perform inventory control such as on-hand counts and reorder (par) levels; reconstitute medications; sell prescription medication; unpack, verify and sort new drug orders onto the shelf; perform the weekly duties — will-call returns and checking for outdated stock on the Rx and OTC shelves; answer the phone and assist patients with refills.",
        "The things a technician is NOT allowed to do, here or anywhere in Kansas: provide any medical advice; perform any counselling on medications; offer any recommendation on an over-the-counter product; perform the final check on a prescription; take a new prescription from a physician or a nurse.",
        "That last list is short on purpose. There is no version of it where being busy, or being certain of the answer, or the pharmacist being on the phone, makes an exception. \"Let me get the pharmacist for you\" is always available and is always the right answer.",
        "Working with the pharmacist: every task you perform is ultimately the pharmacist's responsibility, and you work under their direct and immediate supervision as the Board's rules require. Any problem or discrepancy goes to the pharmacist immediately — not at the end of the shift.",
        "Working with patients: be courteous and tactful when obtaining personal information, and refer every medication-related question to the pharmacist.",
        "Working with physicians and nurses: identify yourself as a pharmacy technician, and relay all clinical questions to the pharmacist.",
        "The code of ethics for pharmacy technicians runs to ten principles. The first is the one that decides the rest: a technician's first consideration is the health and safety of the patient. The others follow from it — honesty and integrity, observing the law, supporting the pharmacist, respecting colleagues, maintaining competence, respecting the patient's individuality and dignity, keeping records confidential and disclosing only with proper authorisation, never assisting in dispensing anything that does not meet the standards required by law, never discrediting the profession and exposing illegal or unethical conduct without fear or favour, and supporting the organisations that advance the profession.",
      ],
      takeaways: [
        "Never: medical advice, counselling, OTC recommendations, the final check, or taking a new prescription by phone.",
        "Identify yourself as a technician; clinical questions go to the pharmacist.",
        "Any discrepancy goes to the pharmacist immediately.",
      ],
    },
    {
      heading: "The laws behind the work — 68-5-15(b)(2)",
      body: [
        "Pharmacy practice is shaped by five sources: federal law and regulation, state law and regulation, professional practice standards, ethical principles, and case law. All five are live; none of them overrides the strictest of the others.",
        "The Food and Drug Administration is the leading federal enforcement agency for regulations concerning drug products. The Drug Enforcement Administration controls the distribution of drugs that may be easily abused — the controlled substances — and sits within the Department of Justice.",
        "1906, the Food and Drug Act. Prohibited interstate commerce in adulterated or misbranded food, drink and drugs, and began government pre-approval of drugs.",
        "1938, the Food, Drug and Cosmetic Act. Passed after 107 people, mostly children, were killed by an untested sulfanilamide preparation. It requires a new drug to be shown safe before it is marketed.",
        "1951, the Durham-Humphrey Amendment. Defines which drugs require a prescription from a licensed practitioner, and created the legend that made them \"legend drugs\".",
        "1962, the Kefauver-Harris Amendments. Requires manufacturers to prove both safety and effectiveness before marketing.",
        "1970, the Poison Prevention Packaging Act. Requires child-resistant packaging on all controlled and most prescription drugs dispensed by pharmacies.",
        "1970, the Controlled Substances Act. Classifies drugs that may be easily abused into schedules and restricts their distribution. Enforced by the DEA.",
        "1990, the Omnibus Budget Reconciliation Act. Requires the PHARMACIST to offer counselling to Medicaid patients about their medications — the reason the offer to counsel is a pharmacist's job and not yours.",
        "1996, the Health Insurance Portability and Accountability Act. Broad and stringent regulation protecting patient privacy. You take the pharmacy's HIPAA course separately and annually; nothing in this course replaces it.",
      ],
      takeaways: [
        "FDA regulates drug products; DEA regulates controlled substances.",
        "Kefauver-Harris 1962: safe AND effective. Durham-Humphrey 1951: what needs a prescription.",
        "OBRA 1990 puts the offer to counsel on the pharmacist.",
      ],
    },
    {
      heading: "Terms, abbreviations and symbols — 68-5-15(b)(3)",
      body: [
        "Route and site. a.d. right ear · a.s. left ear · a.u. both ears · o.d. right eye · o.s. left eye · o.u. both eyes · p.o. by mouth · s.l. sublingual · p.r. rectally · IM intramuscular · SubQ subcutaneous · IV intravenous.",
        "Frequency. q.d. every day · b.i.d. twice daily · t.i.d. three times daily · q.i.d. four times daily · q.o.d. every other day · q4h, q6h, q8h every four, six, eight hours · h.s. at bedtime · a.m. morning · p.m. afternoon · p.r.n. as needed · stat immediately.",
        "Timing and food. a.c. before food · p.c. after food · c with · s without.",
        "Forms. tab tablet · cap capsule · sol solution · susp suspension · supp suppository · ung ointment · SR or XR extended release · DR delayed release · EC enteric coated.",
        "Quantity. gtt drop · tsp teaspoon (5 mL) · tbsp tablespoon (15 mL) · mL millilitre · g gram · mg milligram · mcg microgram · gr grain.",
        "Two of these are on every do-not-use list published and are worth naming: q.d. and q.o.d. are easily misread for one another and for q.i.d. Where a prescription arrives with either and there is any doubt at all, it goes to the pharmacist rather than to your best reading of the handwriting.",
        "Dosage forms you will handle here: aerosols, capsules, creams, emulsions, gels, lotions, ointments, ophthalmic preparations, otic preparations, chewable tablets, controlled-release products, solutions, sublingual tablets, suppositories, suspensions, syrups and transdermal patches.",
        "Routes of administration. Oral — by mouth. Parenteral — every method of systemic administration other than oral or rectal. Topical — skin, mucous membranes, and the transdermal route by ointment or patch. Oral inhalation — into the membrane of the lung by deep breathing, using a metered-dose inhaler, a nebuliser, a turbo-inhaler or an IPPB machine. Nasal inhalation or spray — topical to the mucous membrane, or absorbed into the bloodstream. Sublingual and buccal — under the tongue or in the cheek; the medication dissolves in the mouth and enters the bloodstream directly. Rectal — ointment or suppository, direct blood flow, fast acting, or direct contact with the membrane. Vaginal — for direct action or as a route to the bloodstream.",
      ],
      takeaways: [
        "Learn the ear and eye abbreviations cold: a.d./a.s./a.u. and o.d./o.s./o.u.",
        "q.d. and q.o.d. are the classic misreads. Any doubt goes to the pharmacist.",
        "Parenteral means everything systemic that is not oral or rectal.",
      ],
    },
    {
      heading: "The calculations — 68-5-15(b)(4)",
      body: [
        "Conversions you should know without looking up. 1 inch = 2.54 cm · 1 metre = 39.37 inches · 1 fl oz = 29.57 mL · 1 pint = 473 mL · 1 quart = 946 mL · 1 gallon = 3,785 mL · 1 tsp = 5 mL · 1 tbsp = 15 mL · 1 pound = 454 g · 1 kg = 2.2 lb · 1 lb = 16 oz · 1 grain = 64.8 mg · 1 L = 1,000 mL · 1 dL = 100 mL.",
        "Metric prefixes. 1 kg = 1,000 g · 1 g = 1,000 mg · 1 mg = 1,000 mcg. Moving between them is moving the decimal point three places, and the direction is the only thing to get right: to a smaller unit, multiply; to a larger unit, divide.",
        "Temperature. F = (9/5 × C) + 32. C = 5/9 × (F − 32).",
        "Percentage strengths. Weight to volume is grams per 100 mL. Volume to volume is mL per 100 mL. Weight to weight is grams per 100 g. So 70% dextrose solution is 70 g in every 100 mL, and a 1% cream is 1 g of drug in every 100 g of cream.",
        "Ratio and proportion is the workhorse. Set the strength you have against the amount you need and solve: if you have 250 mg in 5 mL and need 100 mg, then 100/250 × 5 = 2 mL.",
        "Alligation, for mixing two strengths to make a third. Write the higher strength at the top left, the lower at the bottom left, the desired strength in the middle, and subtract diagonally. The difference between the desired and the lower strength gives the parts of the higher; the difference between the higher and the desired gives the parts of the lower. Example: 1% and 5% hydrocortisone to make 30 g of 2.5% — the parts are 2.5 of the 1% and 1.5 of the 5%, four parts in total, so 30 g ÷ 4 = 7.5 g per part, giving 18.75 g of the 1% and 11.25 g of the 5%.",
        "Powder volume, for reconstitution. The final volume of the constituted product equals the volume of diluent added plus the powder volume: FV = D + PV. So the powder volume is the final volume minus the diluent, and knowing it is what lets you make a partial volume correctly.",
        "Days supply, which is the calculation that decides whether a claim is right. Total quantity divided by the amount taken per day. 240 mL taken 5 mL every six hours is 20 mL a day, so twelve days. Where the directions do not support a calculation — an inhaler, an insulin pen, \"as directed\" — you do not guess. Get the clarification, and write it on the hard copy, because an audit will ask to see exactly that note.",
      ],
      takeaways: [
        "1 tsp = 5 mL, 1 tbsp = 15 mL, 1 kg = 2.2 lb, 1 gr = 64.8 mg.",
        "Percentage w/v is grams per 100 mL.",
        "Days supply = quantity ÷ amount per day. Never guessed, always clarified.",
      ],
    },
    {
      heading: "Storage, recalls and the cold chain — 68-5-15(b)(5)",
      body: [
        "Most stock arrives in bulk stock bottles carrying the FDA-required information on the label, and must be stored according to the manufacturer's specifications.",
        "Most drugs are kept at a fairly constant room temperature — 59 to 86 °F. Storage must have adequate ventilation and proper air distribution, and shelves must allow air to move around the stock.",
        "Some drugs are kept in a controlled refrigerator designed for medication, generally between 40 and 42 °F. Refrigerator policy at this pharmacy: no food or drink in a pharmaceutical refrigerator, ever — there is a designated refrigerator for staff food and drink. All pharmaceutical products are stored in the main compartment, never on the door shelves, where the temperature swings every time the door opens.",
        "Monitoring. All refrigerator, freezer and room temperatures are measured twice daily, at opening and closing, using NIST-certified electronic sensors. The pharmacist prints the monthly log on the last working day of the month and files the hard copy. Refrigerators and freezers are alarmed to alert the pharmacist-in-charge when the temperature goes out of range or the power fails.",
        "Recalls. A recall notice may concern a major danger or a minor infraction, and may be voluntary or legally mandated. Class I means the product is likely to cause serious adverse events or death. Class II means temporary but reversible effects. Class III means adverse events are unlikely. A market withdrawal is different again: a minor violation not subject to FDA legal action, where the firm removes the product or corrects the problem.",
        "What happens here when a recall notice arrives: it is communicated to everyone responsible for drug inventory. Every area of the pharmacy, the ordering documents and the dispensing records are inspected. Patients who received the product and their prescribers are called immediately, told of the recall, and given the manufacturer's disposal directions. All affected stock found in the pharmacy is moved to a clearly designated quarantine area until the manufacturer's disposal instructions can be carried out. Subsequent shipments are monitored so the recalled product does not come back in. Copies of every notice and of what was done — quantity disposed of, actions performed, dates — are retained. The pharmacist-in-charge is ultimately responsible for the whole process, and the Drug Recall Checklist Form at the back of the policy manual is what keeps the steps from being missed.",
      ],
      takeaways: [
        "Room temperature 59–86 °F; medication refrigerator 40–42 °F, main compartment only, no food.",
        "Temperatures are read twice daily and the month's log is printed and filed.",
        "Recall: inspect everywhere, call patients and prescribers, quarantine, document what was done.",
      ],
    },
    {
      heading: "Records, filing and retention — 68-5-15(b)(6)",
      body: [
        "This pharmacy's policy will not contradict any legislation, rule or statute enforced by the Kansas Board of Pharmacy, the Bureau of Narcotics and Dangerous Drugs, or the Drug Enforcement Administration. Where they are stricter, they govern.",
        "Patient profiles. Every prescription record carries the patient's name and address, the prescriber's name, the initial date of dispensing, the Rx number, the drug name, strength and quantity, the name of the dispensing pharmacist, and the patient's drug allergies or sensitivities.",
        "Electronic prescriptions are stored electronically, backed up daily, and identified by a numerical prescription system. Any prescription information must be producible in written form within 72 hours of a request.",
        "Everything not sent electronically is reduced to a hard copy, back-tagged with a pharmacy label, and filed daily into one of three groups: non-controls in groups of 500, C3 to C5 in groups of 500, and C2s in groups of 1,000. Each folder is labelled with the date of filing and the range of Rx numbers it contains.",
        "The three-file separation is not housekeeping. C2 hard copies are stored separately from every other prescription, in their own drawer, in increments of 1,000 by Rx number. C3 to C5 are stored together but separate from both the non-controls and the C2s, in their own drawer, in increments of 500. Federal law requires Schedule II records be kept separately from all other records of the registrant.",
        "Retention under Kansas law is five years for: compounding logs, compounding records, controlled substance prescription orders, DEA Form 222 transfer records, controlled substance inventories, distribution records, drug invoices, immunization records, immunization protocols, MTM protocols and MTM patient records, prescription orders, and sterile compounding records. The EDP pharmacist verification logbook is kept five years from the last dispensing date. Medicare paperwork is kept ten years.",
        "Invoices are kept on site for at least twelve months and may then be moved off site — but they still have to be produced within the retention period, so \"off site\" means somewhere findable, not somewhere gone.",
      ],
      takeaways: [
        "Three files: non-controls (500), C3–C5 (500), C2s (1,000) — C2s always in their own drawer.",
        "Five years for almost everything; ten for Medicare paperwork.",
        "Electronic records must be producible on paper within 72 hours.",
      ],
    },
    {
      heading: "Compounding, packaging and labelling — 68-5-15(b)(7)",
      body: [
        "The compounding area. There is a designated area for non-sterile compounding meeting current USP standards. It has adequate space, with equipment and materials placed to prevent mix-ups between ingredients, containers, labels, in-process materials and finished preparations. It is arranged to prevent cross-contamination, adequately lit, and near hot and cold potable water with soap, detergent and single-service towels. It is cleaned with antiseptic methods before and after every compounding occurrence, equipment is cleaned immediately after use, and the area is held at a constant temperature so chemicals do not decompose.",
        "Ingredients. Only USP or NF chemicals from FDA-inspected manufacturers. Every ingredient container carries a complete label, a batch control number and an expiry date. A certificate is obtained for every ingredient purchased. Everything is stored per USP-NF and the manufacturer's specification.",
        "Beyond-use dating is assigned from the day of preparation, per USP, and never exceeds six months here. Non-aqueous formulations: six months, or the earliest expiry of any ingredient, whichever is sooner. Water-containing oral formulations: fourteen days, stored at controlled cold temperature. Water-containing topical, dermal and mucosal liquids and semisolids: thirty days.",
        "The master formulation record for each preparation states the name, strength and dosage form; all necessary calculations; all ingredients and their quantities; compatibility and stability information; the equipment used; mixing instructions including order, temperature and duration; the assignment of a beyond-use date; the type of container required; the label requirements; and the storage requirements.",
        "The compounding record kept for each preparation states the name and strength, the master formulation reference, the sources and lot numbers of every ingredient, the total number of dosage units compounded, the date, the name of the person who compounded it, a description of the final product and the assigned beyond-use date. There is a log of all compounded items with batch records and sample batch labels, equipment maintenance records including balance, refrigerator and freezer checks, and safety data sheets available to everybody who compounds.",
        "Containers. All meet USP requirements; suppliers verify that on request; the pharmacist considers container-drug interactions where a container has sorptive or leaching properties; containers are stored off the floor, handled to prevent contamination, and rotated so the oldest is used first.",
        "Labelling. Compounded preparations meet every federal and state requirement for a dispensed prescription, and additionally carry — on the label or at minimum an auxiliary label — the internal control number, the beyond-use date, the concentration of each active ingredient as appropriate, the name of the final product or of each active ingredient, and the storage conditions.",
        "Hazardous drugs are handled under USP <800> and under this pharmacy's own procedures. If you are unsure whether something you are about to crush, split or count is on the hazardous drug list, stop and ask — that is the moment the exposure happens, and asking costs nothing.",
      ],
      takeaways: [
        "Clean before and after, equipment immediately after use, and never let two products be open at once.",
        "BUD: six months non-aqueous, fourteen days aqueous oral, thirty days aqueous topical.",
        "Every compound gets a control number, a BUD and a compounding record naming who made it.",
      ],
    },
  ],
  questions: [
    {
      q: "How many sections are the prescription drugs organised into on the Rx shelves here?",
      options: ["Three", "Four", "Five", "Six"],
      answer: 2,
      why: "Five: liquids and reconstitutables, unit of use, alpha, topicals, and the refrigerator — organised by storage requirement, use and packaging.",
    },
    {
      q: "What must be verified at the point of sale before a prescription is handed over?",
      options: [
        "The patient's name only",
        "The address or the date of birth",
        "Nothing, if you recognise the patient",
        "Their insurance card",
      ],
      answer: 1,
      why: "Always the address or the date of birth, every time, including for patients you know. The exception you make for a regular is the habit that hands the wrong bag over on a busy Friday.",
    },
    {
      q: "Which federal agency regulates the subset of drugs called controlled substances?",
      options: [
        "The Food and Drug Administration",
        "The Drug Enforcement Administration",
        "The Kansas Board of Pharmacy",
        "The Centers for Medicare and Medicaid Services",
      ],
      answer: 1,
      why: "The DEA, within the Department of Justice, under the Controlled Substances Act of 1970. The FDA is the leading federal agency for drug products generally.",
    },
    {
      q: "Which law first required drugs to be proven both safe AND effective before marketing?",
      options: [
        "The Food and Drug Act of 1906",
        "The Durham-Humphrey Amendment of 1951",
        "The Kefauver-Harris Amendments of 1962",
        "The Controlled Substances Act of 1970",
      ],
      answer: 2,
      why: "Kefauver-Harris, 1962. The 1938 Act had required safety; effectiveness came twenty-four years later.",
    },
    {
      q: "Which law provided the regulations protecting patient health information?",
      options: [
        "OBRA 1990",
        "HIPAA 1996",
        "The Poison Prevention Packaging Act 1970",
        "The Food, Drug and Cosmetic Act 1938",
      ],
      answer: 1,
      why: "HIPAA, 1996. OBRA 1990 is the one that put the offer to counsel on the pharmacist.",
    },
    {
      q: "A technician may do all of the following EXCEPT:",
      options: [
        "Fill prescriptions",
        "Record allergies",
        "Take a new verbal prescription from a nurse",
        "Count controlled substances",
      ],
      answer: 2,
      why: "Taking a new prescription from a physician or nurse is a pharmacist's task. So is counselling, any medical advice, any OTC recommendation, and the final check.",
    },
    {
      q: "Write the sig code for 'take one tablet by mouth twice daily'.",
      options: ["1 tab p.o. q.d.", "1 tab p.o. b.i.d.", "1 tab s.l. b.i.d.", "1 tab p.o. q.i.d."],
      answer: 1,
      why: "b.i.d. is twice daily; q.d. is once daily and q.i.d. is four times daily. p.o. is by mouth, s.l. is sublingual.",
    },
    {
      q: "A prescription calls for 100 mg of a drug you have as 250 mg/5 mL. How many mL do you need?",
      options: ["1 mL", "2 mL", "2.5 mL", "5 mL"],
      answer: 1,
      why: "Ratio and proportion: 100 ÷ 250 × 5 = 2 mL.",
    },
    {
      q: "How many grams of dextrose are in 100 mL of a 70% dextrose solution?",
      options: ["7 g", "70 g", "700 g", "0.7 g"],
      answer: 1,
      why: "A percentage weight-in-volume is grams per 100 mL, so 70% is 70 g in 100 mL.",
    },
    {
      q: "The directions read 5 mL by mouth every six hours and the quantity is 240 mL. What is the days supply?",
      options: ["6 days", "10 days", "12 days", "24 days"],
      answer: 2,
      why: "Every six hours is four doses a day, so 20 mL a day. 240 ÷ 20 = 12 days.",
    },
    {
      q: "2 grains is how many milligrams?",
      options: ["64.8 mg", "129.6 mg", "130 mg", "324 mg"],
      answer: 1,
      why: "1 grain is 64.8 mg, so 2 grains is 129.6 mg. Rounding to 130 is common in practice but the conversion itself is 64.8.",
    },
    {
      q: "A vaccine arrives and the medication refrigerator's door shelf is the only clear space. What do you do?",
      options: [
        "Put it on the door shelf and note it",
        "Store it in the main compartment — pharmaceutical products never go on door shelves",
        "Leave it at room temperature until space is free",
        "Put it in the staff refrigerator",
      ],
      answer: 1,
      why: "The door swings through a temperature range every time it opens. Everything pharmaceutical goes in the main compartment, and no pharmaceutical refrigerator ever holds food or drink.",
    },
    {
      q: "Which recall class involves products likely to cause serious adverse events or death?",
      options: ["Class I", "Class II", "Class III", "A market withdrawal"],
      answer: 0,
      why: "Class I is the most serious. Class II is temporary and reversible, Class III is unlikely to cause harm, and a market withdrawal is a minor violation not subject to FDA legal action.",
    },
    {
      q: "How are C2 hard copies filed at this pharmacy?",
      options: [
        "With the C3–C5s, in groups of 500",
        "With all other prescriptions, in date order",
        "Separately from all other prescriptions, in their own drawer, in increments of 1,000 by Rx number",
        "Scanned only; no paper is kept",
      ],
      answer: 2,
      why: "C2s are always separate — federal law requires Schedule II records be maintained separately from all other records of the registrant. C3–C5s are separate again, in increments of 500.",
    },
    {
      q: "How long are controlled substance prescription orders and drug invoices kept?",
      options: ["One year", "Two years", "Five years", "Ten years"],
      answer: 2,
      why: "Five years under Kansas law, along with inventories, distribution records, compounding records, immunization records and protocols. Medicare paperwork is the ten-year one.",
    },
    {
      q: "What is the maximum beyond-use date assigned to any compounded preparation here?",
      options: ["Fourteen days", "Thirty days", "Six months", "One year"],
      answer: 2,
      why: "Six months, and never longer than the earliest expiry of any ingredient. Water-containing oral formulations are fourteen days refrigerated; water-containing topicals are thirty days.",
    },
    {
      q: "A patient asks which of two cough syrups on the retail shelf is better for their cough. What do you do?",
      options: [
        "Recommend the one most people buy",
        "Read the labels to them and let them choose",
        "Get the pharmacist — a technician may not make an OTC recommendation",
        "Tell them either is fine",
      ],
      answer: 2,
      why: "Offering a recommendation on an OTC product is one of the five things a technician may never do. Being confident about the answer does not change that, and getting the pharmacist takes a moment.",
    },
  ],
};

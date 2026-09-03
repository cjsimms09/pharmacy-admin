import { PERSON_ROLES } from "@/db/schema";
import { PERSON_ROLE_LABEL } from "@/lib/labels";
import { Field } from "@/components/ui";

type Person = {
  firstName: string;
  lastName: string;
  role: string;
  title: string | null;
  isPic: boolean;
  administersVaccines: boolean;
  email: string | null;
  mobile: string | null;
  active: boolean;
  hiredOn: string | null;
  endedOn: string | null;
  notes: string | null;
};

export function PersonForm({ action, person, submitLabel }: { action: (fd: FormData) => Promise<void>; person?: Person; submitLabel: string }) {
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <Field label="First name"><input name="firstName" className="field" required defaultValue={person?.firstName} /></Field>
      <Field label="Last name"><input name="lastName" className="field" required defaultValue={person?.lastName} /></Field>
      <Field label="Role">
        <select name="role" className="field" defaultValue={person?.role ?? "technician"}>
          {PERSON_ROLES.map((r) => <option key={r} value={r}>{PERSON_ROLE_LABEL[r]}</option>)}
        </select>
      </Field>
      <Field label="Title (optional)" hint="e.g. Pharmacist-in-Charge, Certified Technician">
        <input name="title" className="field" defaultValue={person?.title ?? ""} />
      </Field>
      <Field label="Email" hint="Where training links and reminders are sent. Without one they have to be chased by hand.">
        <input name="email" type="email" inputMode="email" className="field" defaultValue={person?.email ?? ""} placeholder="name@example.com" />
      </Field>
      <Field label="Mobile (optional)"><input name="mobile" type="tel" inputMode="tel" className="field" defaultValue={person?.mobile ?? ""} /></Field>
      <Field label="Hired on"><input name="hiredOn" type="date" className="field" defaultValue={person?.hiredOn ?? ""} /></Field>
      <Field label="Employment ended on" hint="Notify the Board within 30 days of any change (K.A.R. 68-7-25)">
        <input name="endedOn" type="date" className="field" defaultValue={person?.endedOn ?? ""} />
      </Field>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isPic" defaultChecked={person?.isPic} /> Pharmacist-in-Charge</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="administersVaccines" defaultChecked={person?.administersVaccines} /> Administers vaccines (requires current CPR card and immunization training)</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={person ? person.active : true} /> Active employee</label>
      </div>
      <Field label="Notes" className="sm:col-span-2"><textarea name="notes" className="field" rows={2} defaultValue={person?.notes ?? ""} /></Field>
      <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">{submitLabel}</button></div>
    </form>
  );
}

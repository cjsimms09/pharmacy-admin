"use client";

import { useFormStatus } from "react-dom";

/**
 * A button that admits it is working.
 *
 * A plain form submit gives no sign that anything happened. For an action that returns in a
 * tenth of a second that is fine; for one that reads five sections of a policy manual against
 * federal regulations it is indistinguishable from a dead button — and the honest report was
 * "I press it and I cannot tell if it is running".
 *
 * Two jobs, and the second matters more than it looks. It says what is happening and roughly how
 * long it will take, so waiting is a decision rather than a guess. And it disables itself, so a
 * second press cannot start the same expensive work twice — which is exactly what somebody does
 * when the first press appears to have done nothing.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className = "btn btn-primary",
  hint,
  disabled,
  formNoValidate,
  formAction,
}: {
  children: React.ReactNode;
  /** What it says while it works. Name the work, not the wait. */
  pendingLabel: string;
  className?: string;
  /** A line under the button while it runs — how long, and that leaving is safe. */
  hint?: string;
  disabled?: boolean;
  /**
   * Skip the browser's validation of the surrounding form.
   *
   * For a button that shares a form with fields it has nothing to do with — the invoice page has
   * one form around the whole table, so a button about filing was demanding the email address
   * belonging to the button about sending.
   */
  formNoValidate?: boolean;
  /**
   * The action this button runs, where it shares a form with buttons that run others. A form
   * inside a form is not HTML and the browser drops it, so a second action on the same table is
   * a button that names its own rather than a form of its own.
   */
  formAction?: (fd: FormData) => void | Promise<void>;
}) {
  const { pending } = useFormStatus();

  return (
    <span className="inline-flex flex-col gap-1">
      <button className={className} disabled={pending || disabled} aria-busy={pending} formNoValidate={formNoValidate} formAction={formAction}>
        {pending ? (
          <span className="inline-flex items-center gap-2">
            {/*
              A moving thing, because a static "working…" reads as stuck. Inline SVG rather than a
              CSS class so this component carries its own spinner and cannot be broken by a
              stylesheet change somewhere else.
            */}
            <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
            {pendingLabel}
          </span>
        ) : (
          children
        )}
      </button>
      {pending && hint && <span className="text-xs text-ink-3">{hint}</span>}
    </span>
  );
}

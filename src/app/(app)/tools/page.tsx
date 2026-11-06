import { redirect } from "next/navigation";

/** Tools is no longer a section: its pages live under Settings, behind "more". */
export default function ToolsPage() {
  redirect("/settings");
}

// Notes on a customer's record: who wrote them and who may change them. The
// author and time always come from the login, never from the request, so a
// note can't be written in someone else's name.

export const NOTE_KINDS = ["office", "therapist", "session"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

type NoteUser = { role?: string; id?: unknown; _id?: unknown; userfName?: string; userlName?: string; userEmail?: string };
type StoredNote = { userId?: string; kind?: string };

const ADMIN_ROLES = new Set(["SUPER_ADMIN", "ADMIN"]);

export const userIdOf = (u?: NoteUser) => String(u?.id ?? u?._id ?? "");

export const authorNameOf = (u?: NoteUser) =>
  `${u?.userfName ?? ""} ${u?.userlName ?? ""}`.trim() || u?.userEmail || "Someone";

/** A note typed on the Customers page is the therapist's or the office's. */
export function noteKindFor(role?: string): NoteKind {
  return role === "THERAPIST" ? "therapist" : "office";
}

/**
 * A session's copy is the record of that visit and is never edited here. Any
 * other note: its author, or an Admin / Super Admin.
 */
export function canEditNote(note: StoredNote, user?: NoteUser): boolean {
  if (note.kind === "session") return false;
  if (ADMIN_ROLES.has(user?.role ?? "")) return true;
  return !!note.userId && note.userId === userIdOf(user);
}

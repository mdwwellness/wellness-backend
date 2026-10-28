import { describe, expect, it } from "vitest";
import { authorNameOf, canEditNote, noteKindFor } from "./customerNotes.ts";

describe("customer notes", () => {
  it("a therapist's note is a therapist note; anyone else's is the office's", () => {
    expect(noteKindFor("THERAPIST")).toBe("therapist");
    expect(noteKindFor("STAFF")).toBe("office");
    expect(noteKindFor("SUPER_ADMIN")).toBe("office");
  });

  it("only the author or an Admin edits a note; a session's copy never", () => {
    const mine = { userId: "u1", kind: "office" };
    expect(canEditNote(mine, { role: "STAFF", id: "u1" })).toBe(true);
    expect(canEditNote(mine, { role: "STAFF", id: "u2" })).toBe(false);
    expect(canEditNote(mine, { role: "THERAPIST", id: "u2" })).toBe(false);
    expect(canEditNote(mine, { role: "ADMIN", id: "u2" })).toBe(true);
    expect(canEditNote({ userId: "u1", kind: "session" }, { role: "SUPER_ADMIN", id: "u1" })).toBe(false);
    expect(canEditNote({ kind: "office" }, { role: "STAFF", id: "" })).toBe(false); // no author on record
  });

  it("names the author from the login", () => {
    expect(authorNameOf({ userfName: "Kamran", userlName: "Siddique" })).toBe("Kamran Siddique");
    expect(authorNameOf({ userEmail: "x@y.com" })).toBe("x@y.com");
  });
});

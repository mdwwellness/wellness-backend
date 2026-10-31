// Google Meet links, made as events on the clinic's Google Calendar (Calendar
// API with conferenceData). The clinic account authorised this app once; its
// refresh token is in the env, so no login screen is needed here.
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN

const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
// A booking save waits on these calls, so a hung Google must not hang it.
const TIMEOUT_MS = 10_000;

export function googleMeetConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
}

async function accessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN ?? "",
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body: any = await res.json().catch(() => ({}));
  // Never log the body: it can carry the token. The error name is enough.
  if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed (${body.error ?? res.status})`);
  return body.access_token;
}

async function call(token: string, url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  if (res.status === 204) return null;
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: any = new Error(`Google Calendar ${res.status}: ${body?.error?.message ?? "request failed"}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Creates a calendar event with a Meet link; the link can take a moment to be ready. */
export async function createMeetEvent(args: {
  summary: string;
  start: Date;
  end: Date;
  description?: string;
}): Promise<{ eventId: string; meetLink: string }> {
  const token = await accessToken();
  let event = await call(token, `${CALENDAR}?conferenceDataVersion=1`, {
    method: "POST",
    body: JSON.stringify({
      summary: args.summary,
      description: args.description,
      start: { dateTime: args.start.toISOString() },
      end: { dateTime: args.end.toISOString() },
      conferenceData: {
        createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } },
      },
    }),
  });
  // Google fills the conference in asynchronously; re-read briefly until it's there.
  for (let i = 0; i < 5 && !event.hangoutLink; i++) {
    if (event.conferenceData?.createRequest?.status?.statusCode === "failure") break;
    await new Promise((r) => setTimeout(r, 1000));
    event = await call(token, `${CALENDAR}/${event.id}`);
  }
  if (!event.hangoutLink) {
    const status = event.conferenceData?.createRequest?.status?.statusCode ?? "none";
    throw new Error(`Google made the event but no Meet link (conference status: ${status})`);
  }
  return { eventId: event.id, meetLink: event.hangoutLink };
}

/** Moves the event; the Meet link stays the same. */
export async function moveMeetEvent(eventId: string, start: Date, end: Date): Promise<void> {
  const token = await accessToken();
  await call(token, `${CALENDAR}/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    body: JSON.stringify({ start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } }),
  });
}

/** Removes the event. One that is already gone counts as removed. */
export async function deleteMeetEvent(eventId: string): Promise<void> {
  const token = await accessToken();
  try {
    await call(token, `${CALENDAR}/${encodeURIComponent(eventId)}`, { method: "DELETE" });
  } catch (err: any) {
    if (err.status !== 404 && err.status !== 410) throw err;
  }
}

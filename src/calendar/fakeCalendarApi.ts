// In-memory подделка Google Calendar REST v3 для тестов: календари, события, syncToken, 410, пагинация.
import type { GCalEvent } from './mapping';

interface StoredEvent extends GCalEvent {
  id: string;
  seq: number;
}

interface StoredCalendar {
  id: string;
  summary: string;
  timeZone?: string;
  events: Map<string, StoredEvent>;
}

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

export class FakeCalendarApi {
  calendars = new Map<string, StoredCalendar>();
  requests: FakeRequest[] = [];
  pageSize = 250;
  /** Следующие N запросов ответят 403 rateLimitExceeded. */
  rateLimitNext = 0;
  /** Токены, выданные до этого seq, считаются протухшими (410). */
  expireTokensBefore = 0;
  private seq = 0;
  private idCounter = 0;

  get writes(): FakeRequest[] {
    return this.requests.filter((r) => r.method !== 'GET');
  }

  get eventWrites(): FakeRequest[] {
    return this.writes.filter((r) => r.path.includes('/events'));
  }

  reset(): void {
    this.requests = [];
  }

  calendar(id?: string): StoredCalendar {
    const c = id ? this.calendars.get(id) : [...this.calendars.values()][0];
    if (!c) throw new Error('нет календаря');
    return c;
  }

  liveEvents(calendarId?: string): StoredEvent[] {
    return [...this.calendar(calendarId).events.values()].filter((e) => e.status !== 'cancelled');
  }

  /** Правка «пользователем в календаре» в обход приложения. */
  userEdit(calendarId: string, eventId: string, patch: Partial<GCalEvent>): void {
    const ev = this.calendar(calendarId).events.get(eventId)!;
    Object.assign(ev, structuredClone(patch), { seq: ++this.seq });
  }

  userInsert(calendarId: string, ev: GCalEvent): string {
    const id = 'u' + ++this.idCounter;
    this.calendar(calendarId).events.set(id, { status: 'confirmed', ...structuredClone(ev), id, seq: ++this.seq });
    return id;
  }

  userDelete(calendarId: string, eventId: string): void {
    const ev = this.calendar(calendarId).events.get(eventId)!;
    ev.status = 'cancelled';
    ev.seq = ++this.seq;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname.replace(/^\/calendar\/v3/, '');
    const query = Object.fromEntries(url.searchParams.entries());
    this.requests.push({ method, path, query, body });

    if (this.rateLimitNext > 0) {
      this.rateLimitNext--;
      return json(403, { error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } });
    }
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (!auth?.startsWith('Bearer ')) return json(401, { error: { message: 'no auth' } });

    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'calendars') return json(404, notFound());

    if (parts.length === 1 && method === 'POST') {
      const id = 'cal' + ++this.idCounter + '@group.calendar.google.com';
      this.calendars.set(id, { id, summary: body.summary, timeZone: body.timeZone, events: new Map() });
      return json(200, { id, summary: body.summary, timeZone: body.timeZone });
    }
    const cal = this.calendars.get(parts[1]);
    if (!cal) return json(404, notFound());

    if (parts.length === 2) {
      if (method === 'GET') return json(200, { id: cal.id, summary: cal.summary, timeZone: cal.timeZone });
      if (method === 'PATCH') {
        Object.assign(cal, { summary: body.summary ?? cal.summary });
        return json(200, { id: cal.id, summary: cal.summary });
      }
    }

    if (parts[2] !== 'events') return json(404, notFound());

    if (parts.length === 3 && method === 'GET') return this.list(cal, query);
    if (parts.length === 3 && method === 'POST') {
      const id = 'e' + ++this.idCounter;
      const ev: StoredEvent = { status: 'confirmed', ...body, id, seq: ++this.seq };
      cal.events.set(id, ev);
      return json(200, strip(ev));
    }
    const ev = cal.events.get(parts[3]);
    if (method === 'PUT') {
      if (!ev) return json(404, notFound());
      const next: StoredEvent = { status: 'confirmed', ...body, id: ev.id, seq: ++this.seq };
      cal.events.set(ev.id, next);
      return json(200, strip(next));
    }
    if (method === 'DELETE') {
      if (!ev) return json(404, notFound());
      if (ev.status === 'cancelled') return json(410, { error: { code: 410, errors: [{ reason: 'deleted' }] } });
      ev.status = 'cancelled';
      ev.seq = ++this.seq;
      return new Response(null, { status: 204 });
    }
    return json(405, { error: { message: 'unsupported' } });
  };

  private list(cal: StoredCalendar, q: Record<string, string>): Response {
    let since: number | undefined;
    if (q.syncToken) {
      since = Number(q.syncToken.replace(/^s/, ''));
      if (!Number.isFinite(since) || since < this.expireTokensBefore) {
        return json(410, { error: { code: 410, message: 'Sync token is no longer valid', errors: [{ reason: 'fullSyncRequired' }] } });
      }
    }
    let all = [...cal.events.values()].sort((a, b) => a.seq - b.seq);
    if (since === undefined) all = all.filter((e) => e.status !== 'cancelled');
    else all = all.filter((e) => e.seq > since!);
    const offset = q.pageToken ? Number(q.pageToken) : 0;
    const page = all.slice(offset, offset + this.pageSize);
    const more = offset + this.pageSize < all.length;
    return json(200, {
      items: page.map(strip),
      ...(more ? { nextPageToken: String(offset + this.pageSize) } : { nextSyncToken: 's' + this.seq }),
    });
  }
}

function strip(e: StoredEvent): GCalEvent {
  const { seq: _seq, ...rest } = e;
  return structuredClone(rest);
}

function notFound() {
  return { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } };
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

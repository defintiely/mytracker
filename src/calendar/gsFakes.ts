// Тестовая среда Apps Script для CALENDAR_GS: in-memory CalendarApp, PropertiesService, Utilities, Session.
// Используется только в тестах (calendarGs.test.ts, calendarSync.test.ts).
import type { CalendarRequest, CalendarResponse, DesiredEvent } from '../sync/scriptApi';
import { CALENDAR_GS } from './calendarGs';

// ---------- время в поясе ----------

function zonedParts(d: Date, tz: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const out: Record<string, string> = {};
  for (const p of parts) out[p.type] = p.value;
  return out;
}

/** Местное время 'YYYY-MM-DDTHH:mm' в поясе tz → момент. */
export function zonedToDate(local: string, tz: string): Date {
  const guess = Date.parse(local + ':00Z');
  const offset = (t: number) => {
    const p = zonedParts(new Date(t), tz);
    return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t); // уточнение у перехода на летнее/зимнее время
  return new Date(t);
}

function formatDate(d: Date, tz: string, pattern: string): string {
  const p = zonedParts(d, tz);
  return pattern
    .replace("'T'", 'T')
    .replace('yyyy', p.year)
    .replace('MM', p.month)
    .replace('dd', p.day)
    .replace('HH', p.hour)
    .replace('mm', p.minute)
    .replace('ss', p.second);
}

function parseDate(s: string, tz: string): Date {
  const m = /^(\d{4}-\d\d-\d\d)(?:[T ](\d\d:\d\d))?$/.exec(s);
  if (!m) throw new Error('parseDate: ' + s);
  return zonedToDate(`${m[1]}T${m[2] ?? '00:00'}`, tz);
}

function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- CalendarApp ----------

let seq = 0;

export class FakeEvent {
  readonly id: string;
  title: string;
  description = '';
  location = '';
  color = '';
  allDay = false;
  /** Для событий со временем. */
  start = new Date(0);
  end = new Date(0);
  /** Для all-day: 'YYYY-MM-DD', конец исключительный. */
  startDay = '';
  endDay = '';
  tags: Record<string, string> = {};
  reminders: number[] = [];
  deleted = false;

  constructor(
    private readonly env: GsEnv,
    title: string,
  ) {
    this.id = `ev${++seq}@google.com`;
    this.title = title;
  }

  // моменты для выборки по окну
  get startMs(): number {
    return this.allDay ? zonedToDate(this.startDay + 'T00:00', this.env.scriptTimeZone).getTime() : this.start.getTime();
  }
  get endMs(): number {
    return this.allDay ? zonedToDate(this.endDay + 'T00:00', this.env.scriptTimeZone).getTime() : this.end.getTime();
  }

  private touch(): void {
    if (this.deleted) throw new Error('Событие удалено');
    this.env.writes++;
  }

  getId = () => this.id;
  getTitle = () => this.title;
  setTitle = (t: string) => {
    this.touch();
    this.title = t;
    return this;
  };
  getDescription = () => this.description;
  setDescription = (s: string) => {
    this.touch();
    this.description = s;
    return this;
  };
  getLocation = () => this.location;
  setLocation = (s: string) => {
    this.touch();
    this.location = s;
    return this;
  };
  getColor = () => this.color;
  setColor = (c: string) => {
    this.touch();
    if (!/^([1-9]|1[01])$/.test(c)) throw new Error('Недопустимый цвет: ' + c);
    this.color = c;
    return this;
  };
  getTag = (k: string): string | null => (k in this.tags ? this.tags[k] : null);
  setTag = (k: string, v: string) => {
    this.touch();
    this.tags[k] = String(v);
    return this;
  };
  isAllDayEvent = () => this.allDay;
  getStartTime = () => new Date(this.startMs);
  getEndTime = () => new Date(this.endMs);
  getAllDayStartDate = () => {
    if (!this.allDay) throw new Error('Не all-day');
    return new Date(this.startMs);
  };
  getAllDayEndDate = () => {
    if (!this.allDay) throw new Error('Не all-day');
    return new Date(this.endMs);
  };
  setTime = (s: Date, e: Date) => {
    this.touch();
    this.allDay = false;
    this.start = new Date(s);
    this.end = new Date(e);
    return this;
  };
  setAllDayDates = (s: Date, e: Date) => {
    this.touch();
    this.allDay = true;
    // как Apps Script: берётся дата в поясе скрипта
    this.startDay = formatDate(s, this.env.scriptTimeZone, 'yyyy-MM-dd');
    this.endDay = formatDate(e, this.env.scriptTimeZone, 'yyyy-MM-dd');
    if (this.endDay <= this.startDay) throw new Error('Конец all-day события не позже начала');
    return this;
  };
  removeAllReminders = () => {
    this.touch();
    this.reminders = [];
    return this;
  };
  addPopupReminder = (m: number) => {
    this.touch();
    if (this.reminders.length >= 5) throw new Error('Больше 5 напоминаний');
    this.reminders.push(m);
    return this;
  };
  deleteEvent = () => {
    this.touch();
    this.deleted = true;
  };
}

export class FakeCalendar {
  readonly id: string;
  events: FakeEvent[] = [];

  constructor(
    private readonly env: GsEnv,
    public name: string,
    readonly timeZone: string,
    readonly primary = false,
  ) {
    this.id = primary ? 'primary@gmail.com' : `cal${++seq}@group.calendar.google.com`;
  }

  getId = () => this.id;
  getName = () => this.name;
  setName = (n: string) => {
    this.env.writes++;
    this.name = n;
    return this;
  };
  getTimeZone = () => this.timeZone;
  isMyPrimaryCalendar = () => this.primary;

  live(): FakeEvent[] {
    return this.events.filter((e) => !e.deleted);
  }

  getEvents = (start: Date, end: Date): FakeEvent[] => {
    this.env.reads++;
    return this.live()
      .filter((e) => e.startMs < end.getTime() && e.endMs > start.getTime())
      .sort((a, b) => a.startMs - b.startMs);
  };
  getEventById = (id: string): FakeEvent | null => {
    this.env.getByIdCalls++;
    return this.events.find((e) => e.id === id && !e.deleted) ?? null;
  };

  private applyOptions(ev: FakeEvent, options?: { description?: string; location?: string }): void {
    if (options?.description) ev.description = options.description;
    if (options?.location) ev.location = options.location;
  }

  createEvent = (title: string, start: Date, end: Date, options?: { description?: string; location?: string }) => {
    this.env.writes++;
    this.env.created++;
    const ev = new FakeEvent(this.env, title);
    ev.start = new Date(start);
    ev.end = new Date(end);
    this.applyOptions(ev, options);
    this.events.push(ev);
    return ev;
  };
  createAllDayEvent = (
    title: string,
    start: Date,
    endOrOptions?: Date | { description?: string; location?: string },
    options?: { description?: string; location?: string },
  ) => {
    this.env.writes++;
    this.env.created++;
    const ev = new FakeEvent(this.env, title);
    ev.allDay = true;
    ev.startDay = formatDate(start, this.env.scriptTimeZone, 'yyyy-MM-dd');
    if (endOrOptions instanceof Date) {
      ev.endDay = formatDate(endOrOptions, this.env.scriptTimeZone, 'yyyy-MM-dd');
    } else {
      ev.endDay = addDays(ev.startDay, 1);
      options = endOrOptions;
    }
    if (ev.endDay <= ev.startDay) throw new Error('Конец all-day события не позже начала');
    this.applyOptions(ev, options);
    this.events.push(ev);
    return ev;
  };

  // ---- действия «пользователя» прямо в календаре ----

  /** Пользователь перенёс событие со временем: новое местное время в поясе tz. */
  userMoveTimed(id: string, start: string, end: string, tz: string): void {
    const ev = this.events.find((e) => e.id === id)!;
    ev.allDay = false;
    ev.start = zonedToDate(start, tz);
    ev.end = zonedToDate(end, tz);
  }
  userMoveAllDay(id: string, startDay: string, endDayExclusive: string): void {
    const ev = this.events.find((e) => e.id === id)!;
    ev.allDay = true;
    ev.startDay = startDay;
    ev.endDay = endDayExclusive;
  }
  userDelete(id: string): void {
    this.events.find((e) => e.id === id)!.deleted = true;
  }
  userCreateTimed(title: string, start: string, end: string, tz: string, location?: string): FakeEvent {
    const ev = new FakeEvent(this.env, title);
    ev.start = zonedToDate(start, tz);
    ev.end = zonedToDate(end, tz);
    if (location) ev.location = location;
    this.events.push(ev);
    return ev;
  }
  userCreateAllDay(title: string, startDay: string, endDayExclusive: string): FakeEvent {
    const ev = new FakeEvent(this.env, title);
    ev.allDay = true;
    ev.startDay = startDay;
    ev.endDay = endDayExclusive;
    this.events.push(ev);
    return ev;
  }
  byEntry(entryId: string): FakeEvent | undefined {
    return this.live().find((e) => e.tags.wltEntry === entryId);
  }
}

export interface GsEnv {
  scriptTimeZone: string;
  calendars: FakeCalendar[];
  properties: Map<string, string>;
  writes: number;
  reads: number;
  created: number;
  getByIdCalls: number;
}

export interface GsRunner {
  env: GsEnv;
  handleCalendar(req: Omit<CalendarRequest, 'action'> & { events: (DesiredEvent & { adoptEventId?: string })[] }): CalendarResponse;
  /** Календарь, который ведёт скрипт (по id из свойств). */
  calendar(): FakeCalendar;
  primary: FakeCalendar;
  resetCounters(): void;
}

/** Исполнить CALENDAR_GS в Node с фейками Apps Script. */
export function createGsRunner(scriptTimeZone = 'Europe/Athens'): GsRunner {
  const env: GsEnv = {
    scriptTimeZone,
    calendars: [],
    properties: new Map(),
    writes: 0,
    reads: 0,
    created: 0,
    getByIdCalls: 0,
  };
  const primary = new FakeCalendar(env, 'owner@example.com', scriptTimeZone, true);
  env.calendars.push(primary);

  const CalendarApp = {
    getCalendarById: (id: string) => env.calendars.find((c) => c.id === id) ?? null,
    getDefaultCalendar: () => primary,
    createCalendar: (name: string, options?: { timeZone?: string }) => {
      env.writes++;
      const c = new FakeCalendar(env, name, options?.timeZone ?? scriptTimeZone);
      env.calendars.push(c);
      return c;
    },
  };
  const props = {
    getProperty: (k: string) => env.properties.get(k) ?? null,
    setProperty: (k: string, v: string) => {
      if (String(v).length > 9 * 1024) throw new Error('Значение свойства больше 9 КБ: ' + k);
      env.properties.set(k, String(v));
      return props;
    },
    setProperties: (o: Record<string, string>) => {
      for (const [k, v] of Object.entries(o)) props.setProperty(k, v);
      return props;
    },
    deleteProperty: (k: string) => {
      env.properties.delete(k);
      return props;
    },
  };
  const PropertiesService = { getScriptProperties: () => props };
  const Utilities = {
    formatDate: (d: Date, tz: string, pattern: string) => formatDate(d, tz, pattern),
    parseDate: (s: string, tz: string, _pattern: string) => parseDate(s, tz),
  };
  const Session = { getScriptTimeZone: () => scriptTimeZone };

  const factory = new Function(
    'CalendarApp',
    'PropertiesService',
    'Utilities',
    'Session',
    CALENDAR_GS + '\nreturn handleCalendar_;',
  ) as (...a: unknown[]) => (req: unknown) => CalendarResponse;
  const handler = factory(CalendarApp, PropertiesService, Utilities, Session);

  return {
    env,
    primary,
    handleCalendar: (req) => handler({ action: 'calendar', ...req }),
    calendar: () => {
      const id = env.properties.get('calendarId');
      const c = env.calendars.find((x) => x.id === id);
      if (!c) throw new Error('Календарь ещё не создан');
      return c;
    },
    resetCounters: () => {
      env.writes = 0;
      env.reads = 0;
      env.created = 0;
      env.getByIdCalls = 0;
    },
  };
}

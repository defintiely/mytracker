// Контракт трекер ↔ Google Apps Script (веб-приложение в аккаунте пользователя).
// Скрипт — единственный «сервер»: читает/пишет файл данных в Drive пользователя и ведёт календарь.
// Google Cloud Console, OAuth Client ID и тестировщики не нужны: скрипт работает от имени владельца.
//
// Транспорт: POST <url> с телом-строкой JSON и заголовком Content-Type: text/plain;charset=utf-8
// (простой запрос без CORS-preflight). Ответ — JSON. Каждый запрос несёт ключ `k`, который вшит
// в текст скрипта при его генерации; запрос с чужим ключом получает { ok:false, code:'forbidden' }.
import type { TrackerDoc } from '../model/types';

/** Подключение: адрес веб-приложения (…/exec) и ключ. Хранится на устройстве. */
export interface ScriptConnection {
  url: string;
  key: string;
}

/** Версия протокола: скрипт отдаёт её в ping; при несовпадении UI просит обновить скрипт. */
export const SCRIPT_PROTOCOL_VERSION = 1;

export type ScriptErrorCode = 'forbidden' | 'conflict' | 'bad_request' | 'internal';

export interface ScriptError {
  ok: false;
  code: ScriptErrorCode;
  error: string;
  /** Для conflict — текущая ревизия файла. */
  rev?: number;
}

// ---------- запросы ----------

export interface PingRequest {
  action: 'ping';
}
export interface PingResponse {
  ok: true;
  protocol: number;
  /** Email владельца скрипта (Session.getEffectiveUser). */
  email?: string;
}

export interface LoadRequest {
  action: 'load';
}
export interface LoadResponse {
  ok: true;
  /** null — файла данных ещё нет. */
  doc: TrackerDoc | null;
  /** Ревизия файла: растёт на 1 при каждом успешном save; 0 — файла нет. */
  rev: number;
}

export interface SaveRequest {
  action: 'save';
  doc: TrackerDoc;
  /** Ревизия, с которой начиналось слияние. Не совпала с текущей → conflict (ничего не записано). */
  baseRev: number;
}
export interface SaveResponse {
  ok: true;
  rev: number;
}

/** Событие, которое должно быть в календаре (готовит трекер из записи). */
export interface DesiredEvent {
  entryId: string;
  /** Хэш содержимого: совпал с выгруженным ранее — событие не трогать. */
  hash: string;
  title: string;
  description?: string;
  location?: string;
  allDay: boolean;
  /** allDay: 'YYYY-MM-DD'; иначе 'YYYY-MM-DDTHH:mm' (местное время в timeZone). */
  start: string;
  /** allDay: день ПОСЛЕ последнего дня (как в Google); иначе 'YYYY-MM-DDTHH:mm'. */
  end: string;
  /** Номер цвета события Google '1'…'11'. */
  colorId?: string;
  /** Напоминания popup, минут до начала. */
  reminders: number[];
  /**
   * Запись создана из чужого события календаря (импорт предложения): если события приложения
   * для неё ещё нет, скрипт помечает тегами само это событие вместо создания дубля.
   */
  adoptEventId?: string;
}

export interface CalendarRequest {
  action: 'calendar';
  calendarName: string;
  timeZone: string;
  /** Полный список событий, которые должны существовать. Событий приложения, которых тут нет, — удалить. */
  events: DesiredEvent[];
  /** Окно (ISO-даты 'YYYY-MM-DD'), в котором искать перенесённые и чужие события. */
  windowStart: string;
  windowEnd: string;
}

/** Событие приложения, которое пользователь перенёс в самом календаре. */
export interface MovedEvent {
  entryId: string;
  allDay: boolean;
  start: string; // формат как в DesiredEvent
  end: string;
}

/** Событие в календаре, созданное не приложением, — предложить импорт. */
export interface ForeignEvent {
  eventId: string;
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  location?: string;
}

export interface CalendarResponse {
  ok: true;
  calendarId: string;
  /** Перенесены пользователем в календаре — трекер подтягивает дату/время в записи. */
  moved: MovedEvent[];
  /** Событие приложения удалено пользователем в календаре — трекер больше не выгружает эту запись, пока она не изменится. */
  removedByUser: string[];
  foreign: ForeignEvent[];
  stats: { created: number; updated: number; deleted: number };
}

export type ScriptRequest = PingRequest | LoadRequest | SaveRequest | CalendarRequest;

/** Клиент скрипта (реализация — src/sync/scriptClient.ts). Бросает OfflineError при сбое сети. */
export interface ScriptClient {
  configured(): boolean;
  ping(): Promise<PingResponse>;
  load(): Promise<LoadResponse>;
  /** Конфликт ревизий возвращается значением, а не исключением. */
  save(doc: TrackerDoc, baseRev: number): Promise<SaveResponse | (ScriptError & { code: 'conflict' })>;
  calendar(req: Omit<CalendarRequest, 'action'>): Promise<CalendarResponse>;
}

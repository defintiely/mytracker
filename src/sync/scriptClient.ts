// Клиент Google Apps Script (контракт — scriptApi.ts) и хранение подключения на устройстве.
//
// Подключение (адрес …/exec и ключ) лежит в localStorage 'wlt.script'. Ключ первого устройства
// генерируется при показе инструкции (localStorage 'wlt.scriptPendingKey') и вшивается в текст скрипта.
// Второе устройство получает и адрес, и ключ одной «ссылкой подключения» `…/exec#k=<ключ>`.
import type { TrackerDoc } from '../model/types';
import type {
  CalendarRequest,
  CalendarResponse,
  LoadResponse,
  PingResponse,
  SaveResponse,
  ScriptClient,
  ScriptConnection,
  ScriptError,
  ScriptRequest,
} from './scriptApi';
import { OfflineError, ScriptCallError } from './errors';

export const LS_CONNECTION = 'wlt.script';
export const LS_PENDING_KEY = 'wlt.scriptPendingKey';

export const MSG_NOT_PUBLIC =
  'Скрипт ответил не так, как нужно. Скорее всего, он развёрнут не с доступом «Все» — пересоздайте развёртывание ' +
  '(«Развернуть» → «Новое развёртывание», «У кого есть доступ: Все») и вставьте новую ссылку.';
export const MSG_FORBIDDEN =
  'Неверный ключ: скрипт создан для другого подключения. Скопируйте код скрипта из трекера заново или вставьте ' +
  'ссылку подключения с первого устройства.';
export const MSG_NOT_FOUND = 'Ссылка не открывается: проверьте, что скопирован «URL веб-приложения» целиком (оканчивается на /exec).';

// ---------------------------------------------------------------- хранение

/** Запасное хранение в памяти, если localStorage недоступен (приватный режим, тесты). */
const memory = new Map<string, string>();

function lsGet(key: string): string | null {
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') return localStorage.getItem(key);
  } catch {
    /* недоступно — берём из памяти */
  }
  return memory.get(key) ?? null;
}

function lsSet(key: string, value: string | null): void {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (typeof localStorage === 'undefined' || typeof localStorage.setItem !== 'function') return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* хранилище недоступно — подключение проживёт до перезагрузки только в памяти */
  }
}
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* слушатель UI не должен ломать остальных */
    }
  }
}

/** Подписка на изменение подключения (подключили / отключили). */
export function onConnectionChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getConnection(): ScriptConnection | undefined {
  const raw = lsGet(LS_CONNECTION);
  if (raw) {
    try {
      const c = JSON.parse(raw) as Partial<ScriptConnection>;
      if (typeof c.url === 'string' && typeof c.key === 'string' && c.url && c.key) return { url: c.url, key: c.key };
    } catch {
      /* испорченная запись — как будто подключения нет */
    }
  }
  return undefined;
}

export function setConnection(url: string, key: string): void {
  lsSet(LS_CONNECTION, JSON.stringify({ url, key }));
  emit();
}

/** Отключить только это устройство: скрипт и данные в Drive остаются. */
export function clearConnection(): void {
  lsSet(LS_CONNECTION, null);
  emit();
}

const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Случайный ключ из 32 латинских букв и цифр. */
export function generateKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += KEY_ALPHABET[b % KEY_ALPHABET.length];
  return out;
}

/** Ключ для нового скрипта: создаётся один раз при показе инструкции и хранится до подключения. */
export function getPendingKey(): string {
  const saved = lsGet(LS_PENDING_KEY);
  if (saved && /^[A-Za-z0-9_-]{8,128}$/.test(saved)) return saved;
  const key = generateKey();
  lsSet(LS_PENDING_KEY, key);
  return key;
}

/** Запомнить ключ для повторного подключения (после «Отключить» — ключ того же скрипта). */
export function setPendingKey(key: string): void {
  lsSet(LS_PENDING_KEY, key);
}

const EXEC_RE = /^https:\/\/script\.google\.com\/(?:macros|a\/macros\/[^/]+)\/s\/[A-Za-z0-9_-]+\/exec$/;

/**
 * Разобрать вставленный текст: адрес веб-приложения `https://script.google.com/macros/s/…/exec`
 * или ссылку подключения `…/exec#k=<ключ>`. Неподходящий текст → undefined.
 */
export function parseConnectionLink(text: string): { url: string; key?: string } | undefined {
  const t = text.trim();
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return undefined;
  }
  const url = `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  if (!EXEC_RE.test(url)) return undefined;
  const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
  const key = hash.get('k')?.trim();
  return key ? { url, key } : { url };
}

/** Ссылка подключения для второго устройства: адрес и ключ вместе. */
export function connectionLink(conn: ScriptConnection): string {
  return `${conn.url}#k=${encodeURIComponent(conn.key)}`;
}

// ---------------------------------------------------------------- клиент

type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

/** Один запрос к скрипту по заданному подключению. Ответ ok:false → ScriptCallError (кроме conflict). */
export async function callScript<T>(
  conn: ScriptConnection,
  req: ScriptRequest,
  fetchImpl: FetchLike = (u, i) => fetch(u, i),
): Promise<T | (ScriptError & { code: 'conflict' })> {
  let res: Awaited<ReturnType<FetchLike>>;
  let text: string;
  try {
    res = await fetchImpl(conn.url, {
      method: 'POST',
      body: JSON.stringify({ k: conn.key, ...req }),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
    });
    text = await res.text();
  } catch {
    throw new OfflineError('Не удалось связаться со скриптом Google');
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ScriptCallError('not_public', res.status === 404 ? MSG_NOT_FOUND : MSG_NOT_PUBLIC);
  }
  if (!data || typeof data !== 'object') throw new ScriptCallError('not_public', MSG_NOT_PUBLIC);
  const d = data as { ok?: boolean; code?: string; error?: string };
  if (d.ok === true) return data as T;
  if (d.code === 'conflict') return data as ScriptError & { code: 'conflict' };
  if (d.code === 'forbidden') throw new ScriptCallError('forbidden', MSG_FORBIDDEN);
  const code = d.code === 'bad_request' ? 'bad_request' : 'internal';
  throw new ScriptCallError(code, 'Ошибка скрипта: ' + (d.error || 'неизвестная ошибка'));
}

export function createScriptClient(
  getConn: () => ScriptConnection | undefined = getConnection,
  fetchImpl?: FetchLike,
): ScriptClient {
  const call = async <T>(req: ScriptRequest) => {
    const conn = getConn();
    if (!conn) throw new ScriptCallError('not_configured', 'Google Drive не подключён');
    return callScript<T>(conn, req, fetchImpl);
  };
  const noConflict = <T>(r: T | ScriptError): T => {
    if ((r as ScriptError).ok === false) throw new ScriptCallError('internal', 'Ошибка скрипта: ' + (r as ScriptError).error);
    return r as T;
  };
  return {
    configured: () => !!getConn(),
    ping: async () => noConflict<PingResponse>(await call<PingResponse>({ action: 'ping' })),
    load: async () => noConflict<LoadResponse>(await call<LoadResponse>({ action: 'load' })),
    save: (doc: TrackerDoc, baseRev: number) => call<SaveResponse>({ action: 'save', doc, baseRev }),
    calendar: async (req: Omit<CalendarRequest, 'action'>) =>
      noConflict<CalendarResponse>(await call<CalendarResponse>({ action: 'calendar', ...req })),
  };
}

/** Клиент по подключению этого устройства. */
export const scriptClient: ScriptClient = createScriptClient();

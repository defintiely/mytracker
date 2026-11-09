// Google Identity Services (token flow) — авторизация в браузере без своего сервера (SPEC §4).
//
// - Client ID: import.meta.env.VITE_GOOGLE_CLIENT_ID или сохранённый на устройстве (setClientId).
// - Токен доступа живёт только в памяти, вместе с временем истечения.
// - В localStorage хранится лишь флаг «пользователь входил» и подсказка-email (не токен), чтобы после
//   перезагрузки попробовать тихий вход (prompt: '').
// - Email аккаунта берётся из Drive about.get (скоуп openid не запрашиваем) — его передаёт
//   синхронизатор через rememberAccount().
import { GOOGLE_SCOPES } from './types';
import { OfflineError } from './errors';

export interface GoogleAuth {
  /** Client ID: import.meta.env.VITE_GOOGLE_CLIENT_ID или сохранённый на устройстве. */
  configured(): boolean;
  setClientId(id: string): void;
  /** Явный вход по кнопке (может показать окно Google). */
  signIn(): Promise<void>;
  signOut(): void;
  /** Действующий токен; тихо обновляет, если истёк. Бросает NeedsAuthError, если нужен вход. */
  getToken(): Promise<string>;
  isSignedIn(): boolean;
}

export class NeedsAuthError extends Error {
  constructor() {
    super('Нужен вход в Google');
  }
}

// ---------------------------------------------------------------- минимальные типы GIS

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GisTokenClient {
  requestAccessToken(overrides?: { prompt?: string; login_hint?: string }): void;
}

interface GisOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    prompt?: string;
    login_hint?: string;
    callback: (r: GisTokenResponse) => void;
    error_callback?: (e: { type?: string; message?: string }) => void;
  }): GisTokenClient;
  revoke(token: string, done?: () => void): void;
  hasGrantedAllScopes?(r: GisTokenResponse, ...scopes: string[]): boolean;
}

declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GisOAuth2 } };
  }
}

// ---------------------------------------------------------------- хранение на устройстве

const LS_CLIENT_ID = 'wlt.google.clientId';
const LS_SIGNED_IN = 'wlt.google.signedIn';
const LS_HINT = 'wlt.google.hint';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SILENT_TIMEOUT_MS = 15_000;
const EXPIRY_MARGIN_MS = 60_000;

function lsGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    /* приватный режим / запрет хранилища — работаем без него */
  }
}

function envClientId(): string | undefined {
  try {
    const v = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_GOOGLE_CLIENT_ID;
    return v && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- состояние

let token: string | undefined;
let tokenExpiresAt = 0;
let gisPromise: Promise<GisOAuth2> | undefined;
let pending: Promise<string> | undefined;
const authListeners = new Set<() => void>();

function emitAuth(): void {
  for (const fn of authListeners) {
    try {
      fn();
    } catch {
      /* слушатель не должен ломать вход */
    }
  }
}

/** Подписка на вход/выход (синхронизатор запускает цикл после входа). */
export function onAuthChange(fn: () => void): () => void {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}

/** Email аккаунта (из Drive about.get) — подсказка для тихого входа и для UI. */
export function rememberAccount(email: string | undefined): void {
  if (email) lsSet(LS_HINT, email);
}

/** Забыть токен в памяти (сервер ответил 401) — следующий getToken попробует тихий вход. */
export function invalidateToken(): void {
  token = undefined;
  tokenExpiresAt = 0;
}

export function getRememberedAccount(): string | undefined {
  return lsGet(LS_HINT) ?? undefined;
}

function clientId(): string | undefined {
  return envClientId() ?? (lsGet(LS_CLIENT_ID)?.trim() || undefined);
}

function tokenValid(): boolean {
  return Boolean(token) && Date.now() < tokenExpiresAt - EXPIRY_MARGIN_MS;
}

function loadGis(): Promise<GisOAuth2> {
  if (typeof window !== 'undefined' && window.google?.accounts?.oauth2) {
    return Promise.resolve(window.google.accounts.oauth2);
  }
  if (typeof document === 'undefined') return Promise.reject(new Error('Google Identity Services: нет браузера'));
  gisPromise ??= new Promise<GisOAuth2>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => {
      const o = window.google?.accounts?.oauth2;
      if (o) resolve(o);
      else reject(new Error('Google Identity Services не загрузился'));
    };
    s.onerror = () => {
      gisPromise = undefined;
      s.remove();
      reject(new OfflineError('Не удалось загрузить Google Identity Services (нет сети?)'));
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

/** Запросить токен. prompt '' — тихо (без окна, если согласие уже дано); undefined — как решит Google. */
async function requestToken(prompt: '' | undefined, timeoutMs?: number): Promise<string> {
  const id = clientId();
  if (!id) throw new Error('Не задан Google Client ID');
  const oauth2 = await loadGis();
  const hint = getRememberedAccount();
  return new Promise<string>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const timer = timeoutMs ? setTimeout(() => finish(() => reject(new NeedsAuthError())), timeoutMs) : undefined;
    const client = oauth2.initTokenClient({
      client_id: id,
      scope: GOOGLE_SCOPES.join(' '),
      ...(hint ? { login_hint: hint } : {}),
      callback: (r) => {
        finish(() => {
          if (r.error || !r.access_token) {
            reject(prompt === '' ? new NeedsAuthError() : new Error(r.error_description || r.error || 'Вход отменён'));
            return;
          }
          // Без drive.appdata синхронизация невозможна (пользователь мог снять галочку).
          const granted = oauth2.hasGrantedAllScopes
            ? oauth2.hasGrantedAllScopes(r, GOOGLE_SCOPES[0])
            : (r.scope ?? '').includes(GOOGLE_SCOPES[0]);
          if (!granted) {
            reject(new Error('Нет доступа к Google Drive: при входе нужно разрешить доступ к данным приложения'));
            return;
          }
          token = r.access_token;
          tokenExpiresAt = Date.now() + Number(r.expires_in ?? 3600) * 1000;
          lsSet(LS_SIGNED_IN, '1');
          resolve(token);
        });
      },
      error_callback: (e) => {
        // popup_closed / popup_failed_to_open / unknown
        finish(() => reject(prompt === '' ? new NeedsAuthError() : new Error(e?.message || e?.type || 'Вход отменён')));
      },
    });
    client.requestAccessToken(prompt === '' ? { prompt: '' } : {});
  });
}

/** Текущий Client ID (из env или сохранённый на устройстве) — для показа в настройках. */
export function getClientId(): string | undefined {
  return clientId();
}

export const auth: GoogleAuth = {
  configured: () => Boolean(clientId()),

  setClientId(id: string) {
    lsSet(LS_CLIENT_ID, id.trim() || null);
    token = undefined;
    tokenExpiresAt = 0;
    emitAuth();
  },

  async signIn() {
    pending = undefined;
    await requestToken(undefined);
    emitAuth();
  },

  signOut() {
    const t = token;
    token = undefined;
    tokenExpiresAt = 0;
    pending = undefined;
    lsSet(LS_SIGNED_IN, null);
    lsSet(LS_HINT, null);
    if (t && typeof window !== 'undefined') {
      loadGis()
        .then((o) => o.revoke(t))
        .catch(() => {});
    }
    emitAuth();
  },

  async getToken() {
    if (tokenValid()) return token!;
    if (!clientId() || lsGet(LS_SIGNED_IN) !== '1') throw new NeedsAuthError();
    // Один тихий запрос на всех одновременных вызывающих.
    pending ??= requestToken('', SILENT_TIMEOUT_MS)
      .catch((e) => {
        throw e instanceof NeedsAuthError || e instanceof OfflineError ? e : new NeedsAuthError();
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  },

  isSignedIn: () => tokenValid() || lsGet(LS_SIGNED_IN) === '1',
};

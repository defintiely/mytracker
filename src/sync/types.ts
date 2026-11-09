// Контракт модулей синхронизации (Drive) и авторизации Google.
export type SyncStatus = 'disabled' | 'needs-auth' | 'offline' | 'syncing' | 'synced' | 'dirty' | 'error';

export interface SyncState {
  status: SyncStatus;
  lastSyncAt?: string;
  error?: string;
  /** Email вошедшего пользователя, если известен. */
  account?: string;
}

export interface Conflict {
  at: string;
  collection: 'entries' | 'contacts' | 'sources' | 'settings';
  id: string;
  field: string;
  /** Значение, которое проиграло (последняя правка победила). */
  lostValue: unknown;
  keptValue: unknown;
}

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.app.created',
];

/** Задача, которую синхронизатор запускает после успешной синхронизации Drive (календарь). */
export type AfterSyncHook = (getToken: () => Promise<string>) => Promise<void>;

// Контракт модулей синхронизации (Drive через Google Apps Script, см. scriptApi.ts).
// 'needs-auth' — наследие входа через OAuth: больше не выставляется, оставлено для совместимости типов.
export type SyncStatus = 'disabled' | 'needs-auth' | 'offline' | 'syncing' | 'synced' | 'dirty' | 'error';

export interface SyncState {
  status: SyncStatus;
  lastSyncAt?: string;
  error?: string;
  /** Email владельца скрипта (из ping), если известен. */
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

/** Задача, которую синхронизатор запускает после успешной синхронизации (календарь). */
export type AfterSyncHook = (client: import('./scriptApi').ScriptClient) => Promise<void>;

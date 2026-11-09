// Индикатор синхронизации в шапке + кнопки «Подключить Google Drive» и «Синхронизировать».
import { useEffect, useState } from 'react';
import type { SyncState } from '../sync/types';
import { syncEngine } from '../sync/syncEngine';
import { errorText } from './util';

export function useSyncState(): SyncState {
  const [s, setS] = useState<SyncState>(() => safeState());
  useEffect(() => {
    try {
      return syncEngine.subscribe(setS);
    } catch {
      return undefined;
    }
  }, []);
  return s;
}

function safeState(): SyncState {
  try {
    return syncEngine.getState();
  } catch (e) {
    return { status: 'error', error: errorText(e) };
  }
}

const LABELS: Record<SyncState['status'], { text: string; icon: string }> = {
  disabled: { text: 'Только на устройстве', icon: '◌' },
  'needs-auth': { text: 'Нужно подключение', icon: '⚠' }, // больше не выставляется
  offline: { text: 'Нет сети', icon: '⨯' },
  syncing: { text: 'Синхронизация…', icon: '⟳' },
  synced: { text: 'Синхронизировано', icon: '✓' },
  dirty: { text: 'Есть несохранённые правки', icon: '●' },
  error: { text: 'Ошибка синхронизации', icon: '!' },
};

/** onConnect — открыть настройки подключения (вкладка «Настройки»). */
export function SyncIndicator({ compact, onConnect }: { compact?: boolean; onConnect?: () => void }) {
  const s = useSyncState();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const l = LABELS[s.status] ?? LABELS.error;
  const title =
    (s.status === 'error' && s.error ? s.error : l.text) +
    (s.lastSyncAt ? ` · последняя: ${new Date(s.lastSyncAt).toLocaleString('ru-RU')}` : '') +
    (s.account ? ` · ${s.account}` : '');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(undefined);
    try {
      await fn();
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const notConnected = s.status === 'disabled' || s.status === 'needs-auth';

  return (
    <div className={`sync sync-${s.status}`} title={title} role="status">
      <span className="sync-icon" aria-hidden>
        {l.icon}
      </span>
      {!compact && <span className="sync-text">{l.text}</span>}
      {notConnected && onConnect && (
        <button type="button" className="small" onClick={onConnect} title="Подключить Google Drive">
          {compact ? 'Подключить' : 'Подключить Google Drive'}
        </button>
      )}
      {!notConnected && (
        <button
          type="button"
          className="small"
          disabled={busy || s.status === 'syncing'}
          onClick={() => run(() => syncEngine.syncNow())}
          aria-label="Синхронизировать"
          title="Синхронизировать"
        >
          {compact ? '⟳' : 'Синхронизировать'}
        </button>
      )}
      {msg && <span className="sync-err">{msg}</span>}
    </div>
  );
}

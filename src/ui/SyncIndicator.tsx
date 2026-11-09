// Индикатор синхронизации в шапке + кнопки «Войти» и «Синхронизировать».
import { useEffect, useState } from 'react';
import type { SyncState } from '../sync/types';
import { syncEngine } from '../sync/syncEngine';
import { auth } from '../sync/auth';
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
  'needs-auth': { text: 'Нужен вход', icon: '⚠' },
  offline: { text: 'Нет сети', icon: '⨯' },
  syncing: { text: 'Синхронизация…', icon: '⟳' },
  synced: { text: 'Синхронизировано', icon: '✓' },
  dirty: { text: 'Есть несохранённые правки', icon: '●' },
  error: { text: 'Ошибка синхронизации', icon: '!' },
};

export function SyncIndicator({ compact }: { compact?: boolean }) {
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

  return (
    <div className={`sync sync-${s.status}`} title={title} role="status">
      <span className="sync-icon" aria-hidden>
        {l.icon}
      </span>
      {!compact && <span className="sync-text">{l.text}</span>}
      {s.status === 'needs-auth' && (
        <button
          type="button"
          className="small primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await auth.signIn();
              await syncEngine.syncNow();
            })
          }
        >
          Войти
        </button>
      )}
      {s.status !== 'disabled' && s.status !== 'needs-auth' && (
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

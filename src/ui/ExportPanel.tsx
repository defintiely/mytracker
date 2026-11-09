// Экспорт ODS (весь трекер или период), бэкап JSON и восстановление из него.
import { useState } from 'react';
import type { TrackerDoc } from '../model/types';
import { exportOds } from '../export/exportOds';
import { exportBackup, parseBackup } from '../export/backup';
import { store } from '../store/store';
import { syncEngine } from '../sync/syncEngine';
import { downloadBlob, errorText, todayISO } from './util';

export function ExportPanel() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState<{ text: string; ok?: boolean }>();
  const [pending, setPending] = useState<TrackerDoc>();

  const doOds = () => {
    setMsg(undefined);
    try {
      const data = exportOds(store.getDoc(), { from: from || undefined, to: to || undefined });
      const blob = new Blob([data as BlobPart], { type: 'application/vnd.oasis.opendocument.spreadsheet' });
      downloadBlob(blob, `tracker-${todayISO()}.ods`);
      setMsg({ text: 'Файл ODS сохранён.', ok: true });
    } catch (e) {
      setMsg({ text: 'Экспорт ODS не удался: ' + errorText(e) });
    }
  };

  const doBackup = () => {
    setMsg(undefined);
    try {
      const json = exportBackup(store.getDoc());
      downloadBlob(new Blob([json], { type: 'application/json' }), `tracker-backup-${todayISO()}.json`);
      setMsg({ text: 'Бэкап сохранён.', ok: true });
    } catch (e) {
      setMsg({ text: 'Бэкап не удался: ' + errorText(e) });
    }
  };

  const onRestoreFile = async (file: File) => {
    setMsg(undefined);
    try {
      const text = await file.text();
      setPending(parseBackup(text));
    } catch (e) {
      setMsg({ text: 'Не удалось прочитать бэкап: ' + errorText(e) });
    }
  };

  const confirmRestore = () => {
    if (!pending) return;
    store.restoreDoc(pending);
    setPending(undefined);
    setMsg({ text: 'Данные восстановлены из бэкапа.', ok: true });
    syncEngine.syncNow().catch(() => {});
  };

  const cur = store.getDoc();
  return (
    <div className="export-panel">
      <h3>ODS</h3>
      <div className="row gap wrap">
        <label>
          С месяца <input type="month" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          По месяц <input type="month" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className="primary" onClick={doOds}>
          {from || to ? 'Выгрузить период в ODS' : 'Выгрузить весь трекер в ODS'}
        </button>
      </div>
      <h3>Бэкап JSON</h3>
      <div className="row gap wrap">
        <button type="button" onClick={doBackup}>
          Скачать бэкап
        </button>
        <label className="btn">
          Восстановить из файла…
          <input
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onRestoreFile(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {pending && (
        <div className="confirm-box">
          <p>
            В бэкапе: {pending.entries.filter((x) => !x.deleted).length} записей, {pending.contacts.length} контактов,{' '}
            {pending.sources.length} источников. Сейчас в трекере: {cur.entries.filter((x) => !x.deleted).length}{' '}
            записей.
          </p>
          <p className="warn">Текущие данные будут заменены содержимым бэкапа.</p>
          <div className="row gap">
            <button type="button" className="danger" onClick={confirmRestore}>
              Заменить данные
            </button>
            <button type="button" onClick={() => setPending(undefined)}>
              Отмена
            </button>
          </div>
        </div>
      )}
      {msg && <div className={'hint ' + (msg.ok ? 'ok' : 'warn')}>{msg.text}</div>}
    </div>
  );
}

// Экран «Настройки»: Google, календарь, общие параметры, цвета, категории, справочники, импорт и экспорт.
import { useEffect, useState } from 'react';
import type { Contact, EntryType, Settings, Source } from '../model/types';
import { TYPE_LABELS } from '../model/types';
import { nowIso } from '../model/entry';
import { store } from '../store/store';
import { useTracker } from '../store/useTracker';
import { auth, getClientId } from '../sync/auth';
import { syncEngine } from '../sync/syncEngine';
import type { Conflict } from '../sync/types';
import { CommitInput, parseAmount } from './common';
import { useSyncState } from './SyncIndicator';
import { ImportWizard } from './ImportWizard';
import { ExportPanel } from './ExportPanel';
import { errorText, makeContact, makeSource, norm } from './util';

export function SettingsView() {
  const doc = useTracker();
  const s = doc.settings;
  return (
    <div className="view settings-view">
      <GoogleSection />
      <CalendarSection s={s} />
      <section className="settings-block">
        <h2>Общее</h2>
        <div className="grid2">
          <div className="field">
            <label htmlFor="st-net">Коэффициент «чистыми ≈»</label>
            <CommitInput
              id="st-net"
              inputMode="decimal"
              value={String(s.netFactor)}
              onCommit={(v) => {
                const n = parseAmount(v);
                if (n !== undefined && n > 0 && n <= 1) store.updateSettings({ netFactor: n });
              }}
            />
            <div className="hint">Грубая оценка после налогов: оборот × коэффициент. Не бухгалтерия.</div>
          </div>
          <div className="field">
            <label htmlFor="st-cc">Код страны для номеров без кода</label>
            <CommitInput
              id="st-cc"
              inputMode="numeric"
              placeholder="например 44"
              value={s.phoneCountryCode ?? ''}
              onCommit={(v) => store.updateSettings({ phoneCountryCode: v.replace(/\D/g, '') || undefined })}
            />
            <div className="hint">Нужен для кнопок WhatsApp и Telegram в карточке контакта.</div>
          </div>
          <div className="field">
            <label htmlFor="st-od">Деньги у посредника «просрочены» через, дней</label>
            <CommitInput
              id="st-od"
              inputMode="numeric"
              value={String(s.intermediaryOverdueDays)}
              onCommit={(v) => {
                const n = parseAmount(v);
                if (n !== undefined && n >= 0) store.updateSettings({ intermediaryOverdueDays: Math.round(n) });
              }}
            />
          </div>
        </div>
      </section>
      <section className="settings-block">
        <h2>Цвета типов</h2>
        <div className="hint">Цвет — главный признак записи: фон строки, полоса карточки, цвет в календаре.</div>
        <div className="row gap wrap">
          {(Object.keys(TYPE_LABELS) as EntryType[]).map((t) => (
            <label key={t} className="color-pick">
              <input
                type="color"
                value={s.typeColors[t]}
                onChange={(e) => store.updateSettings({ typeColors: { ...s.typeColors, [t]: e.target.value } })}
              />
              {TYPE_LABELS[t]}
            </label>
          ))}
        </div>
      </section>
      <Categories s={s} />
      <SourcesSection sources={doc.sources} />
      <ContactsSection contacts={doc.contacts} />
      <section className="settings-block">
        <h2>Импорт из .ods</h2>
        <ImportWizard />
      </section>
      <section className="settings-block">
        <h2>Экспорт и бэкап</h2>
        <ExportPanel />
      </section>
    </div>
  );
}

function GoogleSection() {
  const sync = useSyncState();
  const [clientId, setClientId] = useState(() => getClientId() ?? '');
  const [msg, setMsg] = useState<string>();
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [, force] = useState(0);
  const safe = <T,>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  const configured = safe(() => auth.configured(), false);
  const signedIn = safe(() => auth.isSignedIn(), false);
  const run = async (fn: () => Promise<void> | void) => {
    setMsg(undefined);
    try {
      await fn();
    } catch (e) {
      setMsg(errorText(e));
    }
    force((x) => x + 1);
  };
  useEffect(() => {
    let alive = true;
    syncEngine
      .getConflicts()
      .then((c) => alive && setConflicts(c))
      .catch(() => alive && setConflicts([]));
    return () => {
      alive = false;
    };
  }, [sync.lastSyncAt]);

  return (
    <section className="settings-block">
      <h2>Google Drive</h2>
      <div className="hint">
        Данные синхронизируются через ваш Google Drive (скрытая папка приложения). Своего сервера нет.
      </div>
      <div className="field">
        <label htmlFor="st-cid">OAuth Client ID</label>
        <div className="row gap">
          <input
            id="st-cid"
            value={clientId}
            placeholder={configured ? 'настроен (введите новый, чтобы заменить)' : 'xxxx.apps.googleusercontent.com'}
            onChange={(e) => setClientId(e.target.value)}
          />
          <button
            type="button"
            disabled={!clientId.trim()}
            onClick={() =>
              run(() => {
                auth.setClientId(clientId.trim());
                setClientId('');
              })
            }
          >
            Сохранить
          </button>
        </div>
      </div>
      <div className="row gap wrap">
        <span>
          Статус: <b>{signedIn ? 'вход выполнен' : configured ? 'не выполнен вход' : 'Client ID не задан'}</b>
          {sync.account ? ` · ${sync.account}` : ''}
          {sync.lastSyncAt ? ` · синхронизировано ${new Date(sync.lastSyncAt).toLocaleString('ru-RU')}` : ''}
        </span>
        {signedIn ? (
          <button type="button" onClick={() => run(() => auth.signOut())}>
            Выйти
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={!configured}
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
        <button type="button" onClick={() => run(() => syncEngine.syncNow())}>
          Синхронизировать сейчас
        </button>
      </div>
      {sync.status === 'error' && sync.error && <div className="hint warn">{sync.error}</div>}
      {msg && <div className="hint warn">{msg}</div>}
      <details>
        <summary>Журнал конфликтов {conflicts ? `(${conflicts.length})` : ''}</summary>
        {!conflicts || conflicts.length === 0 ? (
          <div className="muted small">Конфликтов не было.</div>
        ) : (
          <div className="table-wrap">
            <table className="conflicts">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Что</th>
                  <th>Поле</th>
                  <th>Осталось</th>
                  <th>Потеряно</th>
                </tr>
              </thead>
              <tbody>
                {conflicts.map((c, i) => (
                  <tr key={i}>
                    <td>{new Date(c.at).toLocaleString('ru-RU')}</td>
                    <td>
                      {c.collection} {conflictTitle(c)}
                    </td>
                    <td>{c.field}</td>
                    <td>{short(c.keptValue)}</td>
                    <td>{short(c.lostValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  );
}

function conflictTitle(c: Conflict): string {
  if (c.collection !== 'entries') return '';
  const e = store.getDoc().entries.find((x) => x.id === c.id);
  return e ? `«${e.title}»` : '';
}

function short(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? '—' : s.length > 80 ? s.slice(0, 80) + '…' : s;
}

function CalendarSection({ s }: { s: Settings }) {
  const cal = s.calendar;
  const set = (p: Partial<Settings['calendar']>) => store.updateSettings({ calendar: { ...cal, ...p } });
  return (
    <section className="settings-block">
      <h2>Google Календарь</h2>
      <label className="check">
        <input type="checkbox" checked={cal.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Выгружать
        записи в отдельный календарь
      </label>
      <div className="grid2">
        <div className="field">
          <label htmlFor="st-cn">Имя календаря</label>
          <CommitInput id="st-cn" value={cal.calendarName} onCommit={(v) => v.trim() && set({ calendarName: v.trim() })} />
        </div>
        <div className="field">
          <label htmlFor="st-rem">Напоминания, минут до начала</label>
          <CommitInput
            id="st-rem"
            value={cal.reminderMinutes.join(', ')}
            placeholder="1440, 120"
            onCommit={(v) =>
              set({
                reminderMinutes: v
                  .split(/[,;\s]+/)
                  .map(Number)
                  .filter((n) => Number.isFinite(n) && n >= 0)
                  .slice(0, 5),
              })
            }
          />
          <div className="hint">1440 — за сутки, 120 — за 2 часа.</div>
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={cal.includeMoney} onChange={(e) => set({ includeMoney: e.target.checked })} />{' '}
        Писать в событие сумму и источник
      </label>
      <div className="hint">
        Выключено по умолчанию: календарь могут видеть другие люди (если вы им его откроете), и суммы окажутся у них
        перед глазами.
      </div>
      <div className="grid2">
        <div className="field">
          <label htmlFor="st-pm">Личные дела в календаре</label>
          <select
            id="st-pm"
            value={cal.personalMode}
            onChange={(e) => set({ personalMode: e.target.value as Settings['calendar']['personalMode'] })}
          >
            <option value="full">как есть</option>
            <option value="busy">как «Занято», без подробностей</option>
            <option value="skip">не выгружать</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="st-oc">Отменённая запись</label>
          <select
            id="st-oc"
            value={cal.onCancel}
            onChange={(e) => set({ onCancel: e.target.value as Settings['calendar']['onCancel'] })}
          >
            <option value="delete">удалить событие</option>
            <option value="mark">пометить «Отменено»</option>
          </select>
        </div>
      </div>
    </section>
  );
}

function Categories({ s }: { s: Settings }) {
  const [text, setText] = useState('');
  const add = () => {
    const t = text.trim();
    if (!t || s.categories.some((c) => norm(c) === norm(t))) return;
    store.updateSettings({ categories: [...s.categories, t] });
    setText('');
  };
  return (
    <section className="settings-block">
      <h2>Категории</h2>
      <div className="chips">
        {s.categories.map((c) => (
          <span key={c} className="chip">
            {c}
            <button
              type="button"
              className="chip-x"
              aria-label={'Удалить ' + c}
              onClick={() => store.updateSettings({ categories: s.categories.filter((x) => x !== c) })}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="row gap">
        <input value={text} placeholder="Новая категория" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button type="button" onClick={add}>
          Добавить
        </button>
      </div>
    </section>
  );
}

function SourcesSection({ sources }: { sources: Source[] }) {
  const [name, setName] = useState('');
  const live = sources.filter((s) => !s.deleted);
  return (
    <section className="settings-block">
      <h2>Источники и посредники</h2>
      <div className="hint">Алиасы — варианты написания для разбора строк: «петя, пети, петей».</div>
      {live.map((s) => (
        <div className="dict-row" key={s.id}>
          <CommitInput aria-label="Имя" value={s.name} onCommit={(v) => v.trim() && store.upsertSource({ ...s, name: v.trim() })} />
          <CommitInput
            aria-label="Алиасы"
            placeholder="алиасы через запятую"
            value={s.aliases.join(', ')}
            onCommit={(v) =>
              store.upsertSource({
                ...s,
                aliases: v
                  .split(',')
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
          />
          <button
            type="button"
            className="icon-btn"
            aria-label={'Удалить ' + s.name}
            onClick={() => window.confirm(`Удалить источник «${s.name}»?`) && store.upsertSource({ ...s, deleted: true })}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="row gap">
        <input value={name} placeholder="Новый источник" onChange={(e) => setName(e.target.value)} />
        <button
          type="button"
          onClick={() => {
            if (!name.trim()) return;
            store.upsertSource(makeSource(name));
            setName('');
          }}
        >
          Добавить
        </button>
      </div>
    </section>
  );
}

function ContactsSection({ contacts }: { contacts: Contact[] }) {
  const [q, setQ] = useState('');
  const live = contacts
    .filter((c) => !c.deleted)
    .filter((c) => !q || (c.name + ' ' + c.phones.join(' ')).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return (
    <section className="settings-block">
      <h2>Контакты ({contacts.filter((c) => !c.deleted).length})</h2>
      <div className="row gap">
        <input type="search" placeholder="Поиск контакта" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" onClick={() => store.upsertContact(makeContact({ name: q.trim() || 'Новый контакт' }))}>
          + Контакт
        </button>
      </div>
      {live.slice(0, 100).map((c) => (
        <div className="dict-row contact-row" key={c.id}>
          <CommitInput aria-label="Имя" placeholder="Имя" value={c.name} onCommit={(v) => store.upsertContact({ ...c, name: v.trim() })} />
          <CommitInput
            aria-label="Телефоны"
            placeholder="телефоны через запятую"
            value={c.phones.join(', ')}
            onCommit={(v) =>
              store.upsertContact({
                ...c,
                phones: v
                  .split(',')
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
          />
          <CommitInput
            aria-label="Telegram"
            placeholder="telegram @ник"
            value={c.channels.find((x) => x.kind === 'telegram')?.value ?? ''}
            onCommit={(v) =>
              store.upsertContact({
                ...c,
                channels: [
                  ...c.channels.filter((x) => x.kind !== 'telegram'),
                  ...(v.trim() ? [{ kind: 'telegram' as const, value: v.trim() }] : []),
                ],
              })
            }
          />
          <button
            type="button"
            className="icon-btn"
            aria-label={'Удалить ' + c.name}
            onClick={() =>
              window.confirm(`Удалить контакт «${c.name}»?`) && store.upsertContact({ ...c, deleted: true, updatedAt: nowIso() })
            }
          >
            ✕
          </button>
        </div>
      ))}
      {live.length > 100 && <div className="muted small">Показаны первые 100 — уточните поиск.</div>}
    </section>
  );
}

// Экран «Настройки»: Google Drive (через Apps Script), календарь, общие параметры, цвета, категории, справочники, импорт и экспорт.
import { useEffect, useState, type ReactNode } from 'react';
import type { Contact, EntryType, Settings, Source } from '../model/types';
import { TYPE_LABELS } from '../model/types';
import { nowIso } from '../model/entry';
import { store } from '../store/store';
import { useTracker } from '../store/useTracker';
import { OfflineError, ScriptCallError } from '../sync/errors';
import type { PingResponse, ScriptConnection } from '../sync/scriptApi';
import {
  callScript,
  clearConnection,
  connectionLink,
  generateKey,
  getConnection,
  getPendingKey,
  onConnectionChange,
  parseConnectionLink,
  setConnection,
  setPendingKey,
} from '../sync/scriptClient';
import { buildScriptSource } from '../sync/scriptSource';
import { syncEngine } from '../sync/syncEngine';
import type { Conflict, SyncState } from '../sync/types';
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

/** Кнопка «скопировать в буфер» с подтверждением. text() может бросить — тогда «не получилось». */
function CopyButton({
  text,
  label,
  className,
  onFail,
}: {
  text: () => string;
  label: string;
  className?: string;
  onFail?: () => void;
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setState('ok');
    } catch {
      setState('fail');
      onFail?.();
    }
    setTimeout(() => setState('idle'), 2500);
  };
  return (
    <button type="button" className={className} onClick={copy}>
      {state === 'ok' ? 'Скопировано ✓' : state === 'fail' ? 'Не получилось — скопируйте вручную ниже' : label}
    </button>
  );
}

function safeScriptSource(key: string): string {
  try {
    return buildScriptSource(key);
  } catch (e) {
    return '// ' + errorText(e);
  }
}

/** Кнопка «Скопировать код скрипта» + код в поле (на случай, если буфер обмена недоступен). */
function ScriptCodeBlock({ scriptKey, extra }: { scriptKey: string; extra?: ReactNode }) {
  const [show, setShow] = useState(false);
  return (
    <div className="script-code">
      <div className="row gap wrap">
        <CopyButton className="primary" label="Скопировать код скрипта" text={() => buildScriptSource(scriptKey)} onFail={() => setShow(true)} />
        {extra}
        <button type="button" className="link-btn" onClick={() => setShow((v) => !v)}>
          {show ? 'Скрыть код' : 'Показать код'}
        </button>
      </div>
      {show && (
        <textarea
          className="script-code-text"
          readOnly
          rows={8}
          value={safeScriptSource(scriptKey)}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Код скрипта"
        />
      )}
    </div>
  );
}

function connectErrorText(e: unknown, hadKeyInLink: boolean): string {
  if (e instanceof OfflineError) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'Нет интернета — подключитесь к сети и попробуйте снова.';
    return (
      'Скрипт не ответил. Проверьте: при развёртывании выбрано «У кого есть доступ: Все», и скопирован именно ' +
      '«URL веб-приложения» (оканчивается на /exec). Если всё так — создайте новое развёртывание и вставьте новую ссылку.'
    );
  }
  if (e instanceof ScriptCallError && e.code === 'forbidden' && !hadKeyInLink) {
    return (
      'Ключ не совпал: в скрипте другой код. Скопируйте код скрипта (шаг 1) ещё раз, замените им код в редакторе, ' +
      'сохраните и обновите развёртывание. Если трекер уже подключён на другом устройстве — вставьте сюда ссылку оттуда.'
    );
  }
  return errorText(e);
}

/** Пошаговое подключение: скрипт → развёртывание → ссылка. Показывается, пока не подключено. */
function ScriptSetup() {
  const [key, setKey] = useState(() => getPendingKey());
  const newKey = () => {
    if (!window.confirm('Создать новый ключ? Код скрипта изменится: старый скрипт с новым ключом работать не будет.')) return;
    const k = generateKey();
    setPendingKey(k);
    setKey(k);
  };
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();

  const connect = async () => {
    setMsg(undefined);
    const text = link.trim();
    const parsed = parseConnectionLink(text);
    if (!parsed) {
      setMsg(
        /\/dev\b/.test(text)
          ? 'Это тестовая ссылка (оканчивается на /dev) — она работает только в вашем браузере. Нужен «URL веб-приложения» из окна развёртывания, он оканчивается на /exec.'
          : 'Это не похоже на ссылку веб-приложения. Она начинается с https://script.google.com/macros/s/ и оканчивается на /exec.',
      );
      return;
    }
    const conn = { url: parsed.url, key: parsed.key ?? key };
    setBusy(true);
    try {
      await callScript<PingResponse>(conn, { action: 'ping' });
      setConnection(conn.url, conn.key);
      void syncEngine.syncNow();
    } catch (e) {
      setMsg(connectErrorText(e, !!parsed.key));
      setBusy(false);
    }
  };

  return (
    <div className="script-setup">
      <p>
        Подключение делается один раз и занимает около 5 минут. Никаких настроек для разработчиков: вы просто создаёте
        маленький скрипт в своём Google-аккаунте, и он хранит данные трекера в вашем Google Drive.
      </p>
      <ol className="script-steps">
        <li>
          <b>Скопируйте код скрипта</b> и откройте редактор скриптов Google — под тем аккаунтом, где хотите хранить данные.
          <ScriptCodeBlock
            scriptKey={key}
            extra={
              <a className="btn" href="https://script.google.com/create" target="_blank" rel="noreferrer">
                Открыть script.google.com
              </a>
            }
          />
        </li>
        <li>
          В редакторе удалите всё, что там написано, вставьте скопированный код и нажмите 💾 <b>Сохранить</b>.
        </li>
        <li>
          Справа вверху нажмите <b>«Развернуть» → «Новое развёртывание»</b> → шестерёнка рядом с «Выберите тип» →{' '}
          <b>«Веб-приложение»</b>. Выполнять от имени: <b>Я</b>. У кого есть доступ: <b>Все</b>. Нажмите «Развернуть».
        </li>
        <li>
          Google попросит разрешение: <b>«Предоставить доступ»</b> → выберите свой аккаунт → <b>«Дополнительные настройки»</b> →{' '}
          <b>«Перейти на страницу … (небезопасно)»</b> → <b>«Разрешить»</b>. Это ваш собственный скрипт — предупреждение
          стандартное.
        </li>
        <li>
          Скопируйте <b>«URL веб-приложения»</b> (оканчивается на <code>/exec</code>), вставьте его сюда и нажмите «Подключить».
          <div className="field">
            <label htmlFor="st-script-url">Ссылка веб-приложения</label>
            <div className="row gap">
              <input
                id="st-script-url"
                value={link}
                placeholder="https://script.google.com/macros/s/…/exec"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && link.trim() && void connect()}
              />
              <button type="button" className="primary" disabled={busy || !link.trim()} onClick={() => void connect()}>
                {busy ? 'Проверяю…' : 'Подключить'}
              </button>
            </div>
          </div>
        </li>
      </ol>
      {msg && <div className="hint warn">{msg}</div>}
      <div className="hint">
        «У кого есть доступ: Все» значит, что скрипт отвечает без входа в Google. Но без ключа, который вшит в код скрипта, он
        ничего не отдаёт и ничего не меняет. Не публикуйте код скрипта и не пересылайте его посторонним.
      </div>
      <div className="hint">
        Уже подключали трекер на другом устройстве? Шаги 1–4 не нужны: на том устройстве в «Настройках» скопируйте «Ссылку для
        телефона и других устройств» и вставьте её в поле шага 5.
      </div>
      <div className="hint">
        Создаёте скрипт заново, потому что ключ мог попасть к посторонним?{' '}
        <button type="button" className="link-btn" onClick={newKey}>
          Создать новый ключ
        </button>{' '}
        — и затем пройдите шаги 1–5 с новым кодом.
      </div>
    </div>
  );
}

/** Подключено: статус, синхронизация, ссылка для второго устройства, отключение, код скрипта. */
function ScriptConnected({ conn, sync }: { conn: ScriptConnection; sync: SyncState }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const link = connectionLink(conn);
  const syncNow = async () => {
    setBusy(true);
    setMsg(undefined);
    try {
      await syncEngine.syncNow();
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const disconnect = () => {
    if (!window.confirm('Отключить синхронизацию на этом устройстве? Данные на устройстве и в Google Drive останутся.')) return;
    setPendingKey(conn.key); // чтобы потом подключиться к тому же скрипту одной ссылкой
    clearConnection();
  };
  return (
    <div className="script-connected">
      <div className="row gap wrap">
        <span>
          <b>Подключено</b>
          {sync.account ? `: ${sync.account}` : ''}
          {sync.lastSyncAt ? ` · синхронизировано ${new Date(sync.lastSyncAt).toLocaleString('ru-RU')}` : ''}
        </span>
        <button type="button" className="primary" disabled={busy || sync.status === 'syncing'} onClick={() => void syncNow()}>
          {sync.status === 'syncing' ? 'Синхронизация…' : 'Синхронизировать'}
        </button>
        <button type="button" onClick={disconnect}>
          Отключить
        </button>
      </div>
      {sync.status === 'offline' && <div className="hint">Нет связи со скриптом — синхронизация продолжится, когда появится сеть.</div>}
      {sync.error && <div className="hint warn">{sync.error}</div>}
      {msg && <div className="hint warn">{msg}</div>}
      <div className="field">
        <label htmlFor="st-conn-link">Ссылка для телефона и других устройств</label>
        <div className="row gap">
          <input id="st-conn-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <CopyButton label="Копировать" text={() => link} />
        </div>
        <div className="hint">
          На втором устройстве откройте трекер → «Настройки» → вставьте эту ссылку в поле «Ссылка веб-приложения» → «Подключить».
          На script.google.com ничего делать не нужно. В ссылке есть ключ к вашим данным — не пересылайте её посторонним.
        </div>
      </div>
      <details className="setup-guide">
        <summary>Показать код скрипта ещё раз</summary>
        <p className="hint">Нужно, только если трекер попросил обновить скрипт. Ключ в коде тот же, ссылка не изменится.</p>
        <ScriptCodeBlock scriptKey={conn.key} />
        <ol>
          <li>Откройте свой скрипт на script.google.com, удалите старый код, вставьте новый и нажмите 💾 «Сохранить».</li>
          <li>
            «Развернуть» → «Управление развёртываниями» → карандаш → «Версия: Новая версия» → «Развернуть».
          </li>
        </ol>
      </details>
    </div>
  );
}

function GoogleSection() {
  const sync = useSyncState();
  const [conn, setConn] = useState<ScriptConnection | undefined>(() => getConnection());
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  useEffect(() => {
    const off = onConnectionChange(() => setConn(getConnection()));
    return () => {
      off();
    };
  }, []);
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
    <section className="settings-block" id="settings-google">
      <h2>Google Drive через Apps Script</h2>
      <div className="hint">
        Данные синхронизируются через ваш Google Drive: файл лежит в папке «Трекер», там же — ежедневные резервные копии.
        Своего сервера у трекера нет.
      </div>
      {conn ? <ScriptConnected conn={conn} sync={sync} /> : <ScriptSetup />}
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

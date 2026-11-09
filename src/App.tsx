// Каркас приложения: навигация по вкладкам (боковая на ПК, нижняя на телефоне), шапка с синхронизацией
// и быстрым вводом, карточка записи и окно «Где деньги».
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent } from 'react';
import type { Entry } from './model/types';
import { newEntry } from './model/entry';
import { store } from './store/store';
import { UiContext, useIsMobile, type UiApi } from './ui/common';
import { SyncIndicator } from './ui/SyncIndicator';
import { QuickAdd } from './ui/QuickAdd';
import { EntryCard } from './ui/EntryCard';
import { MoneyDialog } from './ui/MoneyEditor';
import { TableView } from './ui/TableView';
import { TasksView } from './ui/TasksView';
import { CalendarView } from './ui/CalendarView';
import { MoneyView } from './ui/MoneyView';
import { SummaryView } from './ui/SummaryView';
import { SettingsView } from './ui/SettingsView';
import { lsGet, lsSet } from './ui/util';
import { useNavMode, useNavSide } from './ui/tablePrefs';
import './ui/styles.css';

export type Tab = 'table' | 'tasks' | 'calendar' | 'money' | 'summary' | 'settings';

export const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'table', label: 'Таблица', icon: '▦' },
  { id: 'tasks', label: 'Задачи', icon: '☑' },
  { id: 'calendar', label: 'Календарь', icon: '📅' },
  { id: 'money', label: 'Деньги', icon: '€' },
  { id: 'summary', label: 'Итоги', icon: '📊' },
  { id: 'settings', label: 'Настройки', icon: '⚙' },
];

type CardState = { id: string } | { draft: Entry } | null;

/** Иконка «☰» для кнопки панели разделов. */
function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function App({ storageError }: { storageError?: string }) {
  const mobile = useIsMobile();
  const [tab, setTabState] = useState<Tab>(() => {
    const saved = lsGet<Tab | null>('wlt.tab', null);
    if (saved && TABS.some((t) => t.id === saved)) return saved;
    return mobile ? 'tasks' : 'table';
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    lsSet('wlt.tab', t);
  };
  const [card, setCard] = useState<CardState>(null);
  const [moneyId, setMoneyId] = useState<string | null>(null);
  const [bannerHidden, setBannerHidden] = useState(false);

  const closeCard = useCallback(() => setCard(null), []);
  const closeMoney = useCallback(() => setMoneyId(null), []);
  const ui = useMemo<UiApi>(
    () => ({
      openEntry: (id) => setCard({ id }),
      createEntry: (partial) => setCard({ draft: newEntry(partial, store.getDoc().settings) }),
      openMoney: (id) => setMoneyId(id),
    }),
    [],
  );

  const current = TABS.find((t) => t.id === tab)!;

  // Панель разделов на ПК/планшете: сторона и режим — настройки устройства («Настройки → Внешний вид»).
  const [navSide] = useNavSide();
  const [navMode] = useNavMode();
  const drawer = !mobile && navMode === 'drawer';
  const [navOpen, setNavOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const navShown = !mobile && (!drawer || navOpen);

  const closeNav = useCallback(() => {
    setNavOpen(false);
    menuBtnRef.current?.focus();
  }, []);

  // Режим сменился на «всегда открыта» (или экран стал телефонным) — выезжающая панель больше не открыта.
  useEffect(() => {
    if (!drawer) setNavOpen(false);
  }, [drawer]);

  // Открытая выезжающая панель: фокус — на текущий раздел, Esc закрывает.
  useEffect(() => {
    if (!drawer || !navOpen) return;
    const nav = navRef.current;
    (nav?.querySelector<HTMLElement>('[aria-current="page"]') ?? nav?.querySelector<HTMLElement>('button'))?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeNav();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer, navOpen, closeNav]);

  /** Tab внутри выезжающей панели ходит по кругу: содержимое под затемнением недоступно. */
  const trapFocus = (ev: RKeyboardEvent<HTMLElement>) => {
    if (!drawer || ev.key !== 'Tab') return;
    const btns = [...(navRef.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    if (!btns.length) return;
    const first = btns[0];
    const last = btns[btns.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  };

  const pickTab = (t: Tab) => {
    setTab(t);
    if (drawer) closeNav();
  };

  const sidenav = navShown && (
    <nav
      id="app-sidenav"
      ref={navRef}
      className={'sidenav' + (drawer ? ' sidenav-drawer' : '')}
      aria-label="Разделы"
      onKeyDown={trapFocus}
    >
      <div className="brand">Трекер работы</div>
      {TABS.map((t) => (
        <button
          type="button"
          key={t.id}
          className={'nav-btn' + (t.id === tab ? ' on' : '')}
          aria-current={t.id === tab ? 'page' : undefined}
          onClick={() => pickTab(t.id)}
        >
          <span className="nav-icon" aria-hidden>
            {t.icon}
          </span>
          {t.label}
        </button>
      ))}
    </nav>
  );

  const menuBtn = drawer && (
    <button
      type="button"
      ref={menuBtnRef}
      className="icon-btn nav-toggle"
      aria-label="Открыть панель разделов"
      aria-expanded={navOpen}
      aria-controls="app-sidenav"
      onClick={() => setNavOpen((o) => !o)}
    >
      <MenuIcon />
    </button>
  );

  const appClass =
    'app' +
    (mobile ? ' is-mobile' : ' is-desktop') +
    (mobile ? '' : ` nav-${navSide}` + (drawer ? ' nav-drawer' : ' nav-pinned'));

  return (
    <UiContext.Provider value={ui}>
      <div className={appClass}>
        {/* Порядок в разметке совпадает с экранным: Tab идёт от панели к содержимому слева направо. */}
        {navSide === 'left' && !drawer && sidenav}
        <div className="main">
          <header className="topbar">
            {navSide === 'left' && menuBtn}
            {mobile && <h1 className="page-title">{current.label}</h1>}
            <div className="topbar-quick">
              <QuickAdd />
            </div>
            <div className="topbar-right">
              <SyncIndicator compact={mobile} onConnect={() => setTab('settings')} />
              <button type="button" className="primary new-btn" onClick={() => ui.createEntry()} aria-label="Новая запись">
                {mobile ? '+' : '+ Запись'}
              </button>
            </div>
            {navSide === 'right' && menuBtn}
          </header>
          {storageError && !bannerHidden && (
            <div className="banner warn" role="alert">
              <span>
                Хранилище браузера недоступно ({storageError}). Приложение работает, но данные живут только в памяти этой
                вкладки: после закрытия они пропадут, если не включена синхронизация с Google Drive. Частый случай —
                приватный режим браузера.
              </span>
              <button type="button" className="icon-btn" aria-label="Скрыть" onClick={() => setBannerHidden(true)}>
                ✕
              </button>
            </div>
          )}
          <main className="content" aria-label={current.label}>
            {tab === 'table' && <TableView />}
            {tab === 'tasks' && <TasksView />}
            {tab === 'calendar' && <CalendarView />}
            {tab === 'money' && <MoneyView />}
            {tab === 'summary' && <SummaryView />}
            {tab === 'settings' && <SettingsView />}
          </main>
        </div>
        {navSide === 'right' && !drawer && sidenav}
        {drawer && navOpen && (
          <>
            <div className="nav-scrim" aria-hidden onClick={closeNav} />
            {sidenav}
          </>
        )}
        {mobile && (
          <nav className="tabbar" aria-label="Разделы">
            {TABS.map((t) => (
              <button
                type="button"
                key={t.id}
                className={'tab-btn' + (t.id === tab ? ' on' : '')}
                aria-current={t.id === tab ? 'page' : undefined}
                onClick={() => setTab(t.id)}
              >
                <span className="tab-icon" aria-hidden>
                  {t.icon}
                </span>
                <span className="tab-label">{t.label}</span>
              </button>
            ))}
          </nav>
        )}
        {card && 'id' in card && <EntryCard key={card.id} id={card.id} onClose={closeCard} />}
        {card && 'draft' in card && <EntryCard key={card.draft.id} draft={card.draft} onClose={closeCard} />}
        {moneyId && <MoneyDialog id={moneyId} onClose={closeMoney} />}
      </div>
    </UiContext.Provider>
  );
}

export default App;

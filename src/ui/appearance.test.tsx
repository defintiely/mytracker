// @vitest-environment jsdom
// «Настройки → Внешний вид»: сторона и режим панели разделов, формат дат (formatDay) и его применение без перезагрузки.
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { store } from '../store/store';
import { emptyDoc, newEntry } from '../model/entry';
import { App } from '../App';
import { TableView } from './TableView';
import { SettingsView } from './SettingsView';
import { NAV_MODE_KEY, NAV_SIDE_KEY, setNavMode, setNavSide } from './tablePrefs';
import { DATE_FORMAT_KEY, WEEKDAY_KEY, formatDay, formatDayRange, formatDateTime, setDateFormat, setShowWeekday, type DateFormat } from './dates';

const sizeProps = ['clientWidth', 'clientHeight', 'offsetHeight'] as const;
const savedDescriptors = sizeProps.map((p) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, p));

beforeAll(async () => {
  // виртуализатору таблицы нужны размеры окна (jsdom раскладку не считает)
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 2000 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 30 });
  await store.load();
});

afterAll(() => {
  sizeProps.forEach((p, i) => {
    const d = savedDescriptors[i];
    if (d) Object.defineProperty(HTMLElement.prototype, p, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[p];
  });
});

beforeEach(() => {
  try {
    localStorage.clear();
    localStorage.setItem('wlt.table.filters', JSON.stringify({ from: '2030-05', to: '2030-05' }));
  } catch {
    /* нет хранилища */
  }
  act(() => {
    setNavSide('left');
    setNavMode('pinned');
    setDateFormat('dd.mm');
    setShowWeekday(true);
  });
  const doc = emptyDoc();
  doc.entries = [newEntry({ title: 'Свадьба', date: '2030-05-10', status: 'booked', amount: 100 })];
  act(() => store.replaceDoc(doc));
});

afterEach(() => cleanup());

const Y = new Date().getFullYear();
const cur = (md: string) => `${Y}-${md}`;

describe('formatDay', () => {
  const cases: [DateFormat, string, string, string][] = [
    // формат, текущий год, другой год (2025), другой год без года (таблица)
    ['dd.mm', '05.12', '05.12.25', '05.12'],
    ['dd mm', '05 12', '05 12 25', '05 12'],
    ['dd mon', '05 дек', '05 дек 2025', '05 дек'],
    ['d month', '5 декабря', '5 декабря 2025', '5 декабря'],
    ['dd.mm.yy', `05.12.${String(Y % 100).padStart(2, '0')}`, '05.12.25', '05.12.25'],
    ['iso', `${Y}-12-05`, '2025-12-05', '2025-12-05'],
  ];
  it.each(cases)('%s: текущий год, чужой год, «в таблице без года»', (format, same, other, inTable) => {
    if (Y === 2025) return; // «чужой» год должен отличаться от текущего
    expect(formatDay(cur('12-05'), { format })).toBe(same);
    expect(formatDay('2025-12-05', { format })).toBe(other);
    expect(formatDay('2025-12-05', { format, year: 'never' })).toBe(inTable);
  });

  it('по умолчанию берёт формат с устройства; пустая дата — пустая строка', () => {
    expect(formatDay(cur('03-07'))).toBe('07.03');
    act(() => setDateFormat('d month'));
    expect(formatDay(cur('03-07'))).toBe('7 марта');
    expect(formatDay(undefined)).toBe('');
  });

  it('короткие месяцы и родительный падеж', () => {
    const shorts = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    const gen = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    for (let m = 1; m <= 12; m++) {
      const iso = cur(`${String(m).padStart(2, '0')}-01`);
      expect(formatDay(iso, { format: 'dd mon' })).toBe(`01 ${shorts[m - 1]}`);
      expect(formatDay(iso, { format: 'd month' })).toBe(`1 ${gen[m - 1]}`);
    }
  });

  it('день недели и диапазон', () => {
    expect(formatDay('2030-05-10', { weekday: true, year: 'never', format: 'dd mon' })).toBe('пт 10 мая');
    expect(
      formatDayRange({ date: '2030-05-10', dateEnd: '2030-05-12', dateTentative: true }, { weekday: true, format: 'dd mm' }),
    ).toBe('пт 10 05 30–12 05 30?');
    expect(formatDayRange({ date: '2030-05-10', dateEnd: '2030-05-10', dateTentative: false }, { format: 'iso' })).toBe(
      '2030-05-10',
    );
  });

  it('formatDateTime: дата в выбранном формате и местное время', () => {
    const d = new Date(2030, 4, 10, 9, 5);
    expect(formatDateTime(d.toISOString(), { format: 'd month' })).toBe('10 мая 2030, 09:05');
  });

  it('неизвестный сохранённый формат — по умолчанию', () => {
    localStorage.setItem(DATE_FORMAT_KEY, JSON.stringify('xx'));
    expect(formatDay(cur('12-05'))).toBe('05.12');
  });
});

const nav = () => screen.queryByRole('navigation', { name: 'Разделы' });
const menuBtn = () => screen.queryByRole('button', { name: 'Открыть панель разделов' });

describe('Панель разделов', () => {
  it('сторона: слева — панель перед содержимым, справа — после; класс каркаса меняется сразу', () => {
    const { container } = render(<App />);
    const app = container.querySelector('.app')!;
    expect(app.classList.contains('nav-left')).toBe(true);
    expect(app.firstElementChild!.classList.contains('sidenav')).toBe(true);

    act(() => setNavSide('right'));
    expect(app.classList.contains('nav-right')).toBe(true);
    expect(app.classList.contains('nav-left')).toBe(false);
    const kids = [...app.children];
    expect(kids.indexOf(container.querySelector('.sidenav')!)).toBeGreaterThan(kids.indexOf(container.querySelector('.main')!));
    expect(menuBtn()).toBeNull(); // «всегда открыта» — кнопки нет
  });

  it('«по кнопке»: панель скрыта, кнопка открывает, выбор раздела закрывает', () => {
    act(() => setNavMode('drawer'));
    const { container } = render(<App />);
    expect(container.querySelector('.app')!.classList.contains('nav-drawer')).toBe(true);
    expect(nav()).toBeNull();
    const btn = menuBtn()!;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    // кнопка — с той же стороны, что панель: слева первой в шапке
    expect(container.querySelector('.topbar')!.firstElementChild).toBe(btn);

    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const n = nav()!;
    expect(n.classList.contains('sidenav-drawer')).toBe(true);
    expect(container.querySelector('.nav-scrim')).toBeTruthy();
    // фокус — в панели, на текущем разделе
    expect(document.activeElement).toBe(within(n).getByRole('button', { name: /Таблица/ }));

    fireEvent.click(within(n).getByRole('button', { name: /Задачи/ }));
    expect(screen.getByRole('main', { name: 'Задачи' })).toBeTruthy();
    expect(nav()).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(btn);
  });

  it('«по кнопке»: Esc и клик по затемнению закрывают, фокус возвращается на кнопку', () => {
    act(() => setNavMode('drawer'));
    const { container } = render(<App />);
    const btn = menuBtn()!;
    fireEvent.click(btn);
    expect(nav()).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(nav()).toBeNull();
    expect(document.activeElement).toBe(btn);

    fireEvent.click(btn);
    fireEvent.click(container.querySelector('.nav-scrim')!);
    expect(nav()).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it('«по кнопке» справа: кнопка последней в шапке, панель справа', () => {
    act(() => {
      setNavMode('drawer');
      setNavSide('right');
    });
    const { container } = render(<App />);
    const btn = menuBtn()!;
    expect(container.querySelector('.topbar')!.lastElementChild).toBe(btn);
    fireEvent.click(btn);
    expect(container.querySelector('.app')!.classList.contains('nav-right')).toBe(true);
    expect(nav()).toBeTruthy();
  });
});

describe('Настройки → Внешний вид', () => {
  it('переключатели сохраняются на устройстве и сразу меняют каркас', () => {
    const { container } = render(<App />);
    fireEvent.click(within(nav()!).getByRole('button', { name: /Настройки/ }));
    const block = screen.getByRole('heading', { name: 'Внешний вид' }).closest('section')!;
    // блок идёт перед «Таблица»
    const headings = [...document.querySelectorAll('.settings-block h2')].map((h) => h.textContent);
    expect(headings.indexOf('Внешний вид')).toBe(headings.indexOf('Таблица') - 1);

    fireEvent.click(within(block).getByRole('radio', { name: 'Справа' }));
    expect(localStorage.getItem(NAV_SIDE_KEY)).toBe('"right"');
    expect(container.querySelector('.app')!.classList.contains('nav-right')).toBe(true);

    fireEvent.click(within(block).getByRole('radio', { name: 'Открывается по кнопке' }));
    expect(localStorage.getItem(NAV_MODE_KEY)).toBe('"drawer"');
    expect(nav()).toBeNull();
    expect(menuBtn()).toBeTruthy();

    fireEvent.click(within(block).getByRole('radio', { name: /^ДД мес/ }));
    expect(localStorage.getItem(DATE_FORMAT_KEY)).toBe('"dd mon"');
  });

  it('у каждого формата — превью на сегодняшней дате', () => {
    render(<SettingsView />);
    const block = screen.getByRole('heading', { name: 'Внешний вид' }).closest('section')!;
    const t = new Date();
    const dd = String(t.getDate()).padStart(2, '0');
    const mm = String(t.getMonth() + 1).padStart(2, '0');
    // превью показывает и день недели, пока он включён
    const wd = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][t.getDay()];
    expect(within(block).getByRole('radio', { name: `ДД.ММ — ${wd} ${dd}.${mm}` })).toBeTruthy();
    expect(within(block).getByRole('radio', { name: `ДД ММ — ${wd} ${dd} ${mm}` })).toBeTruthy();
    expect(within(block).getByRole('radio', { name: `ГГГГ-ММ-ДД — ${wd} ${t.getFullYear()}-${mm}-${dd}` })).toBeTruthy();
    expect((within(block).getByRole('radio', { name: /^ДД\.ММ —/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('смена формата сразу меняет даты в таблице (без года) и подписи «+» (с годом)', () => {
    render(
      <>
        <SettingsView />
        <TableView />
      </>,
    );
    const dateCell = () => document.querySelector('.entry-row .gc-date')!.textContent;
    expect(dateCell()).toContain('пт 10.05');
    expect(dateCell()).not.toContain('2030');
    expect(screen.getByRole('button', { name: 'Добавить ещё на 10.05.30' })).toBeTruthy();

    const block = screen.getByRole('heading', { name: 'Внешний вид' }).closest('section')!;
    fireEvent.click(within(block).getByRole('radio', { name: /^ДД мес/ }));
    expect(dateCell()).toContain('пт 10 мая');
    expect(dateCell()).not.toContain('2030');
    expect(screen.getByRole('button', { name: 'Добавить ещё на 10 мая 2030' })).toBeTruthy();

    fireEvent.click(within(block).getByRole('radio', { name: /^ДД ММ —/ }));
    expect(dateCell()).toContain('пт 10 05');
    expect(screen.getByRole('button', { name: 'Добавить ещё на 10 05 30' })).toBeTruthy();
  });
});

describe('День недели', () => {
  it('выключенный в настройках — не показывается, даже где он предусмотрен', () => {
    expect(formatDay(cur('12-05'), { weekday: true, showWeekday: true })).toMatch(/^(пн|вт|ср|чт|пт|сб|вс) 05\.12$/);
    expect(formatDay(cur('12-05'), { weekday: true, showWeekday: false })).toBe('05.12');
    act(() => setShowWeekday(false));
    expect(formatDay(cur('12-05'), { weekday: true })).toBe('05.12');
  });

  it('галка в «Настройках» пишет в localStorage и сразу убирает день недели в таблице', () => {
    render(<SettingsView />);
    const box = screen.getByLabelText(/Показывать день недели/);
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    expect(localStorage.getItem(WEEKDAY_KEY)).toBe('false');
    cleanup();
    render(<TableView />);
    expect(screen.queryByText(/^(пн|вт|ср|чт|пт|сб|вс) 10\.05/)).toBeNull();
    expect(screen.getAllByText(/10\.05/).length).toBeGreaterThan(0);
  });
});

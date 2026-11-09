// @vitest-environment jsdom
// Таблица: порядок по дате (новые/старые), вид «Год» с карточками месяцев и вид «Месяц», выходные полосой,
// галки саммари карточек года.
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { store } from '../store/store';
import { emptyDoc, newEntry } from '../model/entry';
import { TableView, buildItems } from './TableView';
import {
  TABLE_MODE_KEY,
  TABLE_SORT_KEY,
  YEAR_SUMMARY_KEY,
  setShowEmptyDays,
  setTableMode,
  setTableSort,
  setYearSummary,
} from './tablePrefs';
import { tasksWord } from './YearView';
import { App } from '../App';

// jsdom не считает раскладку — задаём размеры, чтобы виртуализатор рисовал строки (как в emptyDays.test).
const sizeProps = ['clientWidth', 'clientHeight', 'offsetHeight'] as const;
const savedDescriptors = sizeProps.map((p) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, p));

beforeAll(async () => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 4000 });
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

const YEAR = new Date().getFullYear();
const seed = (...entries: ReturnType<typeof newEntry>[]) => {
  const doc = emptyDoc();
  doc.entries = entries;
  act(() => store.replaceDoc(doc));
};

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* нет хранилища */
  }
  act(() => {
    setShowEmptyDays(false);
    setTableSort('desc');
    setTableMode('table');
  });
  seed(
    newEntry({ title: 'Май-1', date: `${YEAR}-05-04`, status: 'booked', amount: 300 }),
    newEntry({ title: 'Май-2', date: `${YEAR}-05-20`, status: 'booked', amount: 200, type: 'joint' }),
    newEntry({ title: 'Июнь-1', date: `${YEAR}-06-10`, status: 'done', amount: 100 }),
    newEntry({ title: 'Прошлый год', date: `${YEAR - 1}-12-05`, status: 'done', amount: 50 }),
    newEntry({ title: 'Без даты-1' }),
  );
});

afterEach(() => cleanup());

/** Строки сетки по порядку: заголовки месяцев, записи (по названию), итоги. */
const gridOrder = () =>
  [...document.querySelector('.grid-body')!.children]
    .sort((a, b) => Number((a as HTMLElement).dataset.index) - Number((b as HTMLElement).dataset.index))
    .map((el) =>
      el.classList.contains('grid-month')
        ? 'M:' + el.childNodes[0].textContent!.trim()
        : el.classList.contains('grid-total')
          ? 'итог'
          : el.classList.contains('entry-row')
            ? el.querySelector('[data-col="title"]')!.textContent!.trim()
            : el.querySelector('.empty-date')?.textContent ?? '?',
    );
const sortBtn = () => screen.getByRole('button', { name: /^Порядок по дате/ });
const modeBtn = (name: 'Таблица' | 'Год') => within(screen.getByRole('group', { name: 'Вид таблицы' })).getByRole('button', { name });
const cards = () => screen.getAllByRole('button', { name: new RegExp(`^[А-Я][а-я]+ ${YEAR}:`) });

describe('Порядок по дате', () => {
  it('переключатель меняет порядок месяцев и записей; «Без даты» и итоги на месте; сохраняется на устройстве', () => {
    render(<TableView />);
    expect(sortBtn().textContent).toBe('Сначала новые ↓');
    expect(gridOrder()).toEqual([
      `M:Июнь ${YEAR}`, 'Июнь-1', 'итог',
      `M:Май ${YEAR}`, 'Май-2', 'Май-1', 'итог',
      `M:Декабрь ${YEAR - 1}`, 'Прошлый год', 'итог',
      'M:Без даты', 'Без даты-1',
    ]);

    fireEvent.click(sortBtn());
    expect(sortBtn().textContent).toBe('Сначала старые ↑');
    expect(sortBtn().getAttribute('aria-label')).toContain('сначала старые');
    expect(localStorage.getItem(TABLE_SORT_KEY)).toBe('"asc"');
    expect(gridOrder()).toEqual([
      `M:Декабрь ${YEAR - 1}`, 'Прошлый год', 'итог',
      `M:Май ${YEAR}`, 'Май-1', 'Май-2', 'итог',
      `M:Июнь ${YEAR}`, 'Июнь-1', 'итог',
      'M:Без даты', 'Без даты-1',
    ]);

    // после перерисовки экрана порядок тот же
    cleanup();
    render(<TableView />);
    expect(sortBtn().textContent).toBe('Сначала старые ↑');
  });

  it('пустые дни идут в том же порядке, что и записи', () => {
    localStorage.setItem('wlt.table.filters', JSON.stringify({ from: `${YEAR}-06`, to: `${YEAR}-06` }));
    act(() => setShowEmptyDays(true));
    render(<TableView />);
    const desc = gridOrder();
    expect(desc[1]).toMatch(/30\.06/);
    expect(desc.indexOf('Июнь-1')).toBeGreaterThan(desc.findIndex((x) => /11\.06/.test(x)));
    expect(desc.at(-1)).toBe('итог');
    fireEvent.click(sortBtn());
    const asc = gridOrder();
    expect(asc[1]).toMatch(/01\.06/);
    expect(asc.indexOf('Июнь-1')).toBeLessThan(asc.findIndex((x) => /11\.06/.test(x)));
    expect(asc.at(-1)).toBe('итог');
  });

  it('buildItems: в обе стороны «Без даты» последняя группа, итоги — последняя строка месяца', () => {
    const doc = emptyDoc();
    const list = [
      newEntry({ title: 'a', date: '2030-03-05' }),
      newEntry({ title: 'b', date: '2030-03-20' }),
      newEntry({ title: 'c', date: '2030-05-01', amount: 10 }),
      newEntry({ title: 'нет даты' }),
    ];
    for (const dir of ['asc', 'desc'] as const) {
      const items = buildItems(list, doc, { currentMonth: '2030-04' }, dir);
      const months = items.flatMap((x) => (x.k === 'month' ? [x.key] : []));
      expect(months.at(-1)).toBe('__none');
      expect(months.slice(0, 3)).toEqual(dir === 'asc' ? ['2030-03', '2030-04', '2030-05'] : ['2030-05', '2030-04', '2030-03']);
      // перед каждым заголовком (кроме первого) — итог предыдущего месяца, если в нём были записи
      items.forEach((x, i) => {
        if (x.k === 'total') expect(['month', undefined]).toContain(items[i + 1]?.k);
      });
      const march = items.flatMap((x) => (x.k === 'empty' && x.key.startsWith('2030-03') ? [x.key] : []));
      expect(march[0]).toBe(dir === 'asc' ? '2030-03-01' : '2030-03-31');
    }
  });
});

describe('Выходные — полосой вокруг ряда', () => {
  it('одиночная суббота — полосы сверху и снизу её строки, у будней — нет; рамки у даты нет; фон строки — цвет типа', () => {
    seed(
      newEntry({ title: 'Суббота', date: '2030-05-04', amount: 10 }),
      newEntry({ title: 'Понедельник', date: '2030-05-06', amount: 10 }),
    );
    render(<TableView />);
    const row = (title: string) => screen.getByText(title).closest('.entry-row') as HTMLElement;
    expect(row('Суббота').classList.contains('wk-start')).toBe(true);
    expect(row('Суббота').classList.contains('wk-end')).toBe(true);
    expect(row('Понедельник').classList.contains('wk-start')).toBe(false);
    expect(row('Понедельник').classList.contains('wk-end')).toBe(false);
    expect(document.querySelector('.date-weekend')).toBeNull();
    expect(row('Суббота').style.getPropertyValue('--tc')).toBeTruthy();
  });
});

describe('Вид «Год»', () => {
  it('12 карточек, итог месяца с записями, листание года; режим сохраняется на устройстве', () => {
    render(<TableView />);
    fireEvent.click(modeBtn('Год'));
    expect(modeBtn('Год').getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem(TABLE_MODE_KEY)).toBe('"year"');
    expect(screen.getByRole('heading', { name: String(YEAR) })).toBeTruthy();
    expect(cards()).toHaveLength(12);

    const may = screen.getByRole('button', { name: `Май ${YEAR}: 2 задачи, оборот €500` });
    const mayCard = may.closest('.ycard') as HTMLElement;
    const sum = (label: string) =>
      [...mayCard.querySelectorAll('.ycard-sum > div')].find((d) => d.querySelector('dt')!.textContent === label)!
        .querySelector('dd')!.textContent;
    expect(sum('Задач')).toBe('2');
    expect(sum('Оборот')).toBe('€500');
    expect(sum('Получено')).toBe('€0');
    expect(sum('Ждём')).toBe('€500');
    expect(sum('Чистыми ≈')).toMatch(/^€/);
    expect(mayCard.classList.contains('is-empty')).toBe(false);
    // точки типов у дней с записями
    expect(mayCard.querySelectorAll('.yday.has-entries')).toHaveLength(2);
    const jan = screen.getByRole('button', { name: `Январь ${YEAR}: 0 задач, оборот €0` }).closest('.ycard')!;
    expect(jan.classList.contains('is-empty')).toBe(true);
    // выходные в мини-календаре никак не выделены: ни у дней, ни у подписей дней недели
    const dayClasses = [...mayCard.querySelectorAll('.ycal > *')].map((el) => el.className);
    expect(dayClasses.filter((c) => /weekend|wd-end/.test(c))).toEqual([]);
    expect(mayCard.querySelectorAll('.yday')).toHaveLength(31);

    fireEvent.click(screen.getByRole('button', { name: 'Предыдущий год' }));
    expect(screen.getByRole('heading', { name: String(YEAR - 1) })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Декабрь ${YEAR - 1}: 1 задача, оборот €50` })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Следующий год' }));
    fireEvent.click(screen.getByRole('button', { name: 'Следующий год' }));
    expect(screen.getAllByRole('button', { name: new RegExp(`^[А-Я][а-я]+ ${YEAR + 1}: 0 задач`) })).toHaveLength(12);

    // режим переживает перерисовку экрана
    cleanup();
    render(<TableView />);
    expect(screen.getAllByRole('button', { name: new RegExp(`^[А-Я][а-я]+ ${YEAR}:`) })).toHaveLength(12);
  });

  it('фильтр по типу меняет итоги карточек и показывает подсказку', () => {
    act(() => setTableMode('year'));
    render(<TableView />);
    expect(screen.queryByText(/только по записям, подходящим под фильтр/)).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Совместная работа/ }));
    expect(screen.getByRole('button', { name: `Май ${YEAR}: 1 задача, оборот €200` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Июнь ${YEAR}: 0 задач, оборот €0` })).toBeTruthy();
    expect(screen.getByText(/только по записям, подходящим под фильтр/)).toBeTruthy();
  });

  it('клик по карточке открывает месяц только с его записями; ‹/› листают; «← Год» возвращает', () => {
    act(() => setTableMode('year'));
    render(<TableView />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Май ${YEAR}:`) }));
    expect(screen.getByRole('heading', { name: `Май ${YEAR}` })).toBeTruthy();
    expect(screen.getByText('Май-1')).toBeTruthy();
    expect(screen.getByText('Май-2')).toBeTruthy();
    expect(screen.queryByText('Июнь-1')).toBeNull();
    expect(screen.queryByText('Без даты-1')).toBeNull();
    // таблица со всеми возможностями: итог, «+» у дат, переключатель порядка
    expect(document.querySelector('.grid-total')).toBeTruthy();
    expect(gridOrder()).toEqual([`M:Май ${YEAR}`, 'Май-2', 'Май-1', 'итог']);
    fireEvent.click(sortBtn());
    expect(gridOrder()).toEqual([`M:Май ${YEAR}`, 'Май-1', 'Май-2', 'итог']);

    fireEvent.click(screen.getByRole('button', { name: `Следующий месяц: Июнь ${YEAR}` }));
    expect(screen.getByRole('heading', { name: `Июнь ${YEAR}` })).toBeTruthy();
    expect(screen.getByText('Июнь-1')).toBeTruthy();
    expect(screen.queryByText('Май-1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: `Предыдущий месяц: Май ${YEAR}` }));
    fireEvent.click(screen.getByRole('button', { name: `Предыдущий месяц: Апрель ${YEAR}` }));
    expect(screen.getByText('В этом месяце записей нет.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '← Год' }));
    expect(cards()).toHaveLength(12);
  });

  it('месяц через границу года и пустые дни месяца по настройке', () => {
    act(() => {
      setTableMode('year');
      setShowEmptyDays(true);
    });
    render(<TableView />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Январь ${YEAR}:`) }));
    expect(document.querySelectorAll('.empty-row')).toHaveLength(31);
    fireEvent.click(screen.getByRole('button', { name: `Предыдущий месяц: Декабрь ${YEAR - 1}` }));
    expect(screen.getByText('Прошлый год')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '← Год' }));
    expect(screen.getByRole('heading', { name: String(YEAR - 1) })).toBeTruthy();
  });

  it('клик по дню мини-календаря открывает этот месяц', () => {
    act(() => setTableMode('year'));
    render(<TableView />);
    const mayCard = screen.getByRole('button', { name: new RegExp(`^Май ${YEAR}:`) }).closest('.ycard')!;
    fireEvent.click(within(mayCard as HTMLElement).getByRole('button', { name: new RegExp(`^Открыть 20 мая ${YEAR}`) }));
    expect(screen.getByRole('heading', { name: `Май ${YEAR}` })).toBeTruthy();
    expect(screen.getByText('Май-2')).toBeTruthy();
  });

  it('«Таблица» возвращает обычный вид со всеми месяцами', () => {
    act(() => setTableMode('year'));
    render(<TableView />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Май ${YEAR}:`) }));
    fireEvent.click(modeBtn('Таблица'));
    expect(localStorage.getItem(TABLE_MODE_KEY)).toBe('"table"');
    expect(screen.getByText('Июнь-1')).toBeTruthy();
    expect(screen.getByText('Без даты-1')).toBeTruthy();
  });

  it('склонение «задача»', () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25, 111].map((n) => tasksWord(n))).toEqual([
      'задача', 'задачи', 'задач', 'задач', 'задач', 'задача', 'задачи', 'задач', 'задач',
    ]);
  });
});

describe('Саммари карточек года — галки в настройках', () => {
  const nav = () => screen.getByRole('navigation', { name: 'Разделы' });
  const mayCard = () => screen.getByRole('button', { name: new RegExp(`^Май ${YEAR}:`) }).closest('.ycard') as HTMLElement;
  const shown = () => [...mayCard().querySelectorAll('.ycard-sum dt')].map((d) => d.textContent);

  it('по умолчанию всё включено; снятые галки скрывают поля, сохраняются на устройстве; все сняты — только название и календарь', () => {
    render(<App />);
    fireEvent.click(within(nav()).getByRole('button', { name: /Настройки/ }));
    const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
    const names = ['Число задач', 'Оборот', 'Чистыми ≈', 'Получено', 'Ждём'];
    expect(names.map((n) => box(n).checked)).toEqual([true, true, true, true, true]);
    fireEvent.click(box('Оборот'));
    fireEvent.click(box('Ждём'));
    expect(JSON.parse(localStorage.getItem(YEAR_SUMMARY_KEY)!)).toEqual({
      count: true,
      turnover: false,
      net: true,
      received: true,
      waiting: false,
    });

    fireEvent.click(within(nav()).getByRole('button', { name: /Таблица/ }));
    fireEvent.click(modeBtn('Год'));
    expect(shown()).toEqual(['Задач', 'Чистыми ≈', 'Получено']);
    // подпись карточки для диктора от галок не зависит
    expect(screen.getByRole('button', { name: `Май ${YEAR}: 2 задачи, оборот €500` })).toBeTruthy();

    fireEvent.click(within(nav()).getByRole('button', { name: /Настройки/ }));
    for (const n of names) if (box(n).checked) fireEvent.click(box(n));
    fireEvent.click(within(nav()).getByRole('button', { name: /Таблица/ }));
    expect(document.querySelectorAll('.ycard')).toHaveLength(12);
    expect(document.querySelector('.ycard-sum')).toBeNull();
    expect(screen.queryByText('Записей нет')).toBeNull();
    expect(mayCard().querySelector('.ycard-name')!.textContent).toBe('Май');
    expect(mayCard().querySelectorAll('.yday')).toHaveLength(31);
    expect(screen.getByRole('button', { name: `Май ${YEAR}: 2 задачи, оборот €500` })).toBeTruthy();

    // после перезапуска экрана настройка та же
    cleanup();
    render(<TableView />);
    expect(document.querySelector('.ycard-sum')).toBeNull();
  });

  it('карточки обновляются сразу при смене настройки', () => {
    act(() => setTableMode('year'));
    render(<TableView />);
    expect(shown()).toEqual(['Задач', 'Оборот', 'Чистыми ≈', 'Получено', 'Ждём']);
    act(() => setYearSummary({ count: false, turnover: true, net: false, received: false, waiting: false }));
    expect(shown()).toEqual(['Оборот']);
    // одно поле включено — у пустого месяца по-прежнему «Записей нет»
    const jan = screen.getByRole('button', { name: new RegExp(`^Январь ${YEAR}:`) }).closest('.ycard')!;
    expect(jan.querySelector('p.ycard-sum')!.textContent).toBe('Записей нет');
  });

  it('испорченное значение в хранилище — все поля по умолчанию', () => {
    localStorage.setItem(YEAR_SUMMARY_KEY, JSON.stringify({ turnover: 'нет', waiting: false, лишнее: true }));
    act(() => setTableMode('year'));
    render(<TableView />);
    expect(shown()).toEqual(['Задач', 'Оборот', 'Чистыми ≈', 'Получено']);
  });
});

describe('Телефон', () => {
  const savedMatchMedia = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((q: string) => ({
      matches: true,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = savedMatchMedia;
  });

  it('«Год» → карточки, «Месяц» → компактный список только этого месяца; выходные полосой', () => {
    // первая суббота мая текущего года, следующее за ней воскресенье и среда той же недели
    let sat = 1;
    while (new Date(YEAR, 4, sat).getDay() !== 6) sat++;
    const dd = (n: number) => `${YEAR}-05-${String(n).padStart(2, '0')}`;
    seed(
      newEntry({ title: 'Суббота', date: dd(sat), amount: 10 }),
      newEntry({ title: 'Среда', date: dd(sat + 4), amount: 10 }),
      newEntry({ title: 'Июнь', date: `${YEAR}-06-08`, amount: 10 }),
    );
    act(() => {
      setTableMode('year');
      setShowEmptyDays(true);
    });
    render(<TableView />);
    expect(document.querySelectorAll('.ycard')).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Май ${YEAR}:`) }));
    expect(document.querySelector('.mlist-scroll')).toBeTruthy();
    expect(screen.getByText('Суббота')).toBeTruthy();
    expect(screen.queryByText('Июнь')).toBeNull();
    expect(document.querySelector('.date-weekend')).toBeNull();
    // «сначала новые»: блок выходных — пустое воскресенье (полоса над ним), затем запись субботы (полоса под ней)
    const satRow = screen.getByText('Суббота').closest('.mlist-entry')!;
    expect([satRow.classList.contains('wk-start'), satRow.classList.contains('wk-end')]).toEqual([false, true]);
    const wedRow = screen.getByText('Среда').closest('.mlist-entry')!;
    expect(wedRow.classList.contains('wk-start') || wedRow.classList.contains('wk-end')).toBe(false);
    // дата текущего года подписывается без года
    const sunLabel = `Добавить на ${String(sat + 1).padStart(2, '0')}.05`;
    const sun = screen.getByRole('button', { name: sunLabel }).closest('.mlist-empty')!;
    expect([sun.classList.contains('wk-start'), sun.classList.contains('wk-end')]).toEqual([true, false]);
    expect(sun.classList.contains('weekend')).toBe(false);
  });
});

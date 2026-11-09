// @vitest-environment jsdom
// Пустые дни в таблице и «+» на дату: настройка на устройстве, флажок над таблицей, фильтры, карточка новой записи.
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { store } from '../store/store';
import { emptyDoc, newEntry } from '../model/entry';
import { App } from '../App';
import { TableView, buildItems } from './TableView';
import { SHOW_EMPTY_DAYS_KEY, setShowEmptyDays } from './tablePrefs';

// jsdom не считает раскладку: без размеров окна прокрутки виртуализатор не рисует ни одной строки.
// Окно высокое, чтобы месяц целиком (31 строка) помещался; что рисуется не всё — отдельный тест ниже.
// offsetHeight — высота измеренной строки (иначе jsdom даёт 0 и строки «схлопываются»).
const sizeProps = ['clientWidth', 'clientHeight', 'offsetHeight'] as const;
const savedDescriptors = sizeProps.map((p) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, p));

beforeAll(async () => {
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

const seed = (...entries: ReturnType<typeof newEntry>[]) => {
  const doc = emptyDoc();
  doc.entries = entries;
  act(() => store.replaceDoc(doc));
};

beforeEach(() => {
  try {
    localStorage.clear();
    // Период — только май 2030: в таблице ровно один месяц, все его строки помещаются в окно виртуализатора.
    localStorage.setItem('wlt.table.filters', JSON.stringify({ from: '2030-05', to: '2030-05' }));
  } catch {
    /* нет хранилища */
  }
  act(() => setShowEmptyDays(false));
  seed(newEntry({ title: 'Свадьба', date: '2030-05-10', status: 'booked', amount: 100 }));
});

afterEach(() => cleanup());

const emptyRows = () => [...document.querySelectorAll('.empty-row')] as HTMLElement[];
const emptyDates = () => emptyRows().map((r) => r.querySelector('.empty-date')!.textContent);
const flag = () => screen.getByRole('checkbox', { name: 'Пустые дни' }) as HTMLInputElement;
const nav = () => screen.getByRole('navigation', { name: 'Разделы' });

describe('Таблица: пустые дни', () => {
  it('по умолчанию выключено; флажок показывает пустые дни месяца по порядку вместе с записями и скрывает обратно', () => {
    render(<TableView />);
    expect(flag().checked).toBe(false);
    expect(emptyRows()).toHaveLength(0);

    fireEvent.click(flag());
    expect(localStorage.getItem(SHOW_EMPTY_DAYS_KEY)).toBe('true');
    // В мае 31 день, 10-е занято записью.
    expect(emptyRows()).toHaveLength(30);
    expect(screen.getByRole('button', { name: 'Добавить на 01.05.2030' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Добавить на 10.05.2030' })).toBeNull();
    expect(emptyDates()[0]).toBe('ср 01.05.2030');
    // Выходные помечены.
    const sat = screen.getByRole('button', { name: 'Добавить на 04.05.2030' }).closest('.empty-row')!;
    expect(sat.classList.contains('weekend')).toBe(true);
    expect(screen.getByRole('button', { name: 'Добавить на 06.05.2030' }).closest('.empty-row')!.classList.contains('weekend')).toBe(false);

    // Запись 10-го стоит между 9-м и 11-м.
    const body = document.querySelector('.grid-body')!;
    const order = [...body.children]
      .sort((a, b) => Number((a as HTMLElement).dataset.index) - Number((b as HTMLElement).dataset.index))
      .map((el) => (el.classList.contains('entry-row') ? 'запись' : el.querySelector('.empty-date')?.textContent ?? el.className));
    const i = order.indexOf('запись');
    expect(order[i - 1]).toBe('чт 09.05.2030');
    expect(order[i + 1]).toBe('сб 11.05.2030');
    // Итоги месяца на месте.
    expect(document.querySelector('.grid-total')).toBeTruthy();

    fireEvent.click(flag());
    expect(emptyRows()).toHaveLength(0);
    expect(localStorage.getItem(SHOW_EMPTY_DAYS_KEY)).toBe('false');
  });

  it('при текстовом поиске и фильтре по типу пустые дни скрыты и видна подсказка', () => {
    render(<TableView />);
    fireEvent.click(flag());
    expect(emptyRows()).toHaveLength(30);
    expect(screen.queryByText('Пустые дни скрыты, пока включён фильтр')).toBeNull();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск' }), { target: { value: 'свад' } });
    expect(emptyRows()).toHaveLength(0);
    expect(screen.getByText('Пустые дни скрыты, пока включён фильтр')).toBeTruthy();
    expect(screen.getByText('Свадьба')).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск' }), { target: { value: '' } });
    expect(emptyRows()).toHaveLength(30);

    fireEvent.click(screen.getByRole('checkbox', { name: /Основная работа/ }));
    expect(emptyRows()).toHaveLength(0);
    expect(screen.getByText('Пустые дни скрыты, пока включён фильтр')).toBeTruthy();
  });

  it('Enter и Tab при редактировании пропускают строки пустых дней', () => {
    seed(
      newEntry({ title: 'Первая', date: '2030-05-01', status: 'booked', amount: 100 }),
      newEntry({ title: 'Вторая', date: '2030-05-04', status: 'booked', amount: 200 }),
    );
    act(() => setShowEmptyDays(true));
    render(<TableView />);
    expect(emptyRows()).toHaveLength(29);
    // пустые строки не редактируются: в них нет ячеек-полей
    expect(document.querySelector('.empty-row .cell-view')).toBeNull();

    const titleCell = document.querySelector('.entry-row [data-col="title"] .cell-view') as HTMLElement;
    fireEvent.click(titleCell);
    const first = screen.getByRole('textbox', { name: 'Название' }) as HTMLInputElement;
    expect(first.value).toBe('Первая');
    fireEvent.keyDown(first, { key: 'Enter' });
    // строки 2-го и 3-го (пустые) пропущены — сразу запись 4-го
    expect((screen.getByRole('textbox', { name: 'Название' }) as HTMLInputElement).value).toBe('Вторая');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Название' }), { key: 'Escape' });

    // Tab с последней колонки первой записи — на первую колонку следующей записи, мимо пустых дней.
    const lastCol = document.querySelector('.entry-row [data-col="status"] .cell-view') as HTMLElement;
    fireEvent.click(lastCol);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Статус' }), { key: 'Tab' });
    const typeEditor = screen.getByRole('combobox', { name: 'Тип' });
    expect(typeEditor.closest('.entry-row')!.textContent).toContain('Вторая');
  });

  it('строки пустых дней виртуализуются: за годы истории в DOM лишь видимая часть', () => {
    localStorage.removeItem('wlt.table.filters');
    seed(
      newEntry({ title: 'Давно', date: '2020-01-15', status: 'done', amount: 100 }),
      newEntry({ title: 'Свадьба', date: '2030-05-10', status: 'booked', amount: 100 }),
    );
    act(() => setShowEmptyDays(true));
    render(<TableView />);
    const all = buildItems(store.getDoc().entries, store.getDoc(), { currentMonth: '2026-11' });
    expect(all.filter((x) => x.k === 'empty').length).toBeGreaterThan(3000);
    expect(emptyRows().length).toBeGreaterThan(0);
    expect(emptyRows().length).toBeLessThan(150);
  });

  it('клик по «+» в ячейке даты не включает редактирование даты', () => {
    render(<TableView />);
    fireEvent.click(screen.getByRole('button', { name: 'Добавить ещё на 10.05.2030' }));
    expect(document.querySelector('.cell-input')).toBeNull();
  });

  it('buildItems: месяцы без «дыр», текущий месяц, предел периода; «Без даты» — без пустых дней', () => {
    const doc = emptyDoc();
    const a = newEntry({ title: 'A', date: '2030-03-05' });
    const b = newEntry({ title: 'B', date: '2030-05-10', dateEnd: '2030-05-12' });
    const c = newEntry({ title: 'Без даты' });
    const months = (items: ReturnType<typeof buildItems>) => items.filter((x) => x.k === 'month').map((x) => x.key);

    const all = buildItems([a, b, c], doc, { currentMonth: '2030-08' });
    expect(months(all)).toEqual(['2030-08', '2030-07', '2030-06', '2030-05', '2030-04', '2030-03', '__none']);
    // итоги — только у месяцев с записями
    expect(all.filter((x) => x.k === 'total').map((x) => x.key)).toEqual(['2030-05', '2030-03']);
    // многодневная запись занимает все свои дни
    const mayEmpty = all.flatMap((x) => (x.k === 'empty' && x.key.startsWith('2030-05') ? [x.key] : []));
    expect(mayEmpty).toHaveLength(28);
    expect(mayEmpty).not.toContain('2030-05-11');
    // «Без даты» — последняя группа и только сама запись
    const noneAt = all.findIndex((x) => x.k === 'month' && x.key === '__none');
    expect(all.slice(noneAt + 1).map((x) => x.k)).toEqual(['row']);

    // текущий месяц за пределом периода не добавляется, внутри — добавляется
    expect(months(buildItems([a, b], doc, { currentMonth: '2030-08', to: '2030-07' }))).toEqual([
      '2030-05',
      '2030-04',
      '2030-03',
    ]);
    expect(months(buildItems([a, b], doc, { currentMonth: '2030-06', from: '2030-04', to: '2030-07' }))).toEqual([
      '2030-06',
      '2030-05',
      '2030-04',
      '2030-03',
    ]);
    // без записей — только текущий месяц
    const none = buildItems([], doc, { currentMonth: '2026-02' });
    expect(months(none)).toEqual(['2026-02']);
    expect(none.filter((x) => x.k === 'empty')).toHaveLength(28);
    // выключено — как раньше
    expect(buildItems([a, b], doc).some((x) => x.k === 'empty')).toBe(false);
  });
});

describe('«+» на дату → карточка новой записи', () => {
  const createFrom = (buttonName: string, date: string) => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: buttonName }));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText('Когда') as HTMLInputElement).value).toBe(date);
    // черновик: в store до «Создать» ничего нового
    expect(store.getDoc().entries).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    const created = store.getDoc().entries.find((x) => x.title !== 'Свадьба')!;
    expect(store.getDoc().entries).toHaveLength(2);
    expect(created.date).toBe(date);
    expect(created.type).toBe('main');
  };

  it('«+» у записи', () => createFrom('Добавить ещё на 10.05.2030', '2030-05-10'));

  it('«+» у пустого дня', () => {
    act(() => setShowEmptyDays(true));
    createFrom('Добавить на 11.05.2030', '2030-05-11');
  });
});

describe('Переключатель в настройках и флажок в таблице', () => {
  it('меняют одно и то же значение', () => {
    render(<App />);
    fireEvent.click(within(nav()).getByRole('button', { name: /Настройки/ }));
    const setting = screen.getByRole('checkbox', { name: 'Показывать пустые дни в таблице' }) as HTMLInputElement;
    expect(setting.checked).toBe(false);
    fireEvent.click(setting);

    fireEvent.click(within(nav()).getByRole('button', { name: /Таблица/ }));
    expect(flag().checked).toBe(true);
    expect(emptyRows()).toHaveLength(30);
    fireEvent.click(flag());
    expect(emptyRows()).toHaveLength(0);

    fireEvent.click(within(nav()).getByRole('button', { name: /Настройки/ }));
    expect((screen.getByRole('checkbox', { name: 'Показывать пустые дни в таблице' }) as HTMLInputElement).checked).toBe(false);
  });

  it('таблица реагирует на смену значения сразу, без перерисовки экрана', () => {
    render(<TableView />);
    expect(emptyRows()).toHaveLength(0);
    act(() => setShowEmptyDays(true));
    expect(flag().checked).toBe(true);
    expect(emptyRows()).toHaveLength(30);
  });
});

describe('Телефон: компактный список', () => {
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

  it('пустые дни и «+» у записи есть и в списке', () => {
    act(() => setShowEmptyDays(true));
    render(<TableView />);
    expect(document.querySelectorAll('.mlist-empty')).toHaveLength(30);
    expect(screen.getByRole('button', { name: 'Добавить на 01.05.2030' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Добавить ещё на 10.05.2030' })).toBeTruthy();
    // строка записи по-прежнему открывает карточку отдельной кнопкой
    expect(screen.getByText('Свадьба').closest('button.mlist-row')).toBeTruthy();
  });
});

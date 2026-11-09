// @vitest-environment jsdom
// Ширина и порядок колонок десктопной таблицы: клавиатура на ручке, ↑/↓ в меню, сброс, сохранение.
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { store } from '../store/store';
import { emptyDoc, newEntry } from '../model/entry';
import { COL_MAX, COL_MIN, LAYOUT_KEY, TableView, mergeOrder } from './TableView';

// jsdom не считает раскладку: без размеров окна прокрутки виртуализатор не рисует ни одной строки.
const sizeProps = ['clientWidth', 'clientHeight'] as const;
const savedDescriptors = sizeProps.map((p) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, p));

beforeAll(async () => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
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
  } catch {
    /* нет хранилища */
  }
  const doc = emptyDoc();
  doc.entries = [
    newEntry({ title: 'Первая', date: '2030-05-01', status: 'booked', amount: 100 }),
    newEntry({ title: 'Вторая', date: '2030-05-02', status: 'booked', amount: 200 }),
  ];
  act(() => store.replaceDoc(doc));
});

afterEach(() => cleanup());

const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent);
const template = () => (document.querySelector('.grid-inner') as HTMLElement).style.getPropertyValue('--cols');
const saved = () => JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null');

describe('Таблица: ширина и порядок колонок', () => {
  it('по умолчанию — исходный порядок, у колонок есть ручки ширины', () => {
    render(<TableView />);
    expect(headers()).toEqual(['', 'Тип', 'Дата', 'Время', 'Название', 'Место', 'Категория', 'Сумма', 'Где деньги', 'Способ', 'Контакт', 'Источник', 'Статус']);
    const handle = screen.getByRole('separator', { name: 'Ширина: Дата' });
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.tabIndex).toBe(0);
    // у служебной колонки «открыть карточку» ручки нет
    expect(screen.getAllByRole('separator')).toHaveLength(12);
  });

  it('клавиатура на ручке меняет ширину, она в grid-template и в localStorage', () => {
    render(<TableView />);
    const handle = screen.getByRole('separator', { name: 'Ширина: Дата' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(template()).toContain('106px');
    expect(saved().sizing).toEqual({ date: 106 });
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(saved().sizing.date).toBe(156);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(saved().sizing.date).toBe(146);
    // нижний предел
    for (let i = 0; i < 5; i++) fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(saved().sizing.date).toBe(COL_MIN);
    expect(template()).toContain(`${COL_MIN}px`);

    // ширина переживает перерисовку экрана
    cleanup();
    render(<TableView />);
    expect(template()).toContain(`${COL_MIN}px`);
  });

  it('сохранённая ширина вне пределов обрезается', () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ order: [], sizing: { title: 5000, date: 'x', nope: 100 } }));
    render(<TableView />);
    expect(template()).toContain(`${COL_MAX}px`);
  });

  it('↑/↓ в меню «Колонки» меняют порядок заголовков, «Сбросить» возвращает исходное', () => {
    render(<TableView />);
    const before = headers();
    fireEvent.click(screen.getByRole('button', { name: 'Ниже: Время' }));
    expect(headers().slice(0, 6)).toEqual(['', 'Тип', 'Дата', 'Название', 'Время', 'Место']);
    fireEvent.click(screen.getByRole('button', { name: 'Выше: Статус' }));
    expect(headers().slice(-3)).toEqual(['Контакт', 'Статус', 'Источник']);
    expect(saved().order.slice(0, 5)).toEqual(['open', 'type', 'date', 'title', 'time']);
    // первую колонку меню выше не поднять — служебная колонка остаётся первой
    expect((screen.getByRole('button', { name: 'Выше: Тип' }) as HTMLButtonElement).disabled).toBe(true);

    const place = screen.getByRole('separator', { name: 'Ширина: Место' });
    fireEvent.keyDown(place, { key: 'ArrowRight' });
    fireEvent.keyDown(place, { key: 'ArrowRight' });
    expect(template()).toContain('140px');

    fireEvent.click(screen.getByRole('button', { name: 'Сбросить ширину и порядок' }));
    expect(headers()).toEqual(before);
    expect(template()).not.toContain('140px');
    expect(localStorage.getItem(LAYOUT_KEY)).toBeNull();
  });

  it('сохранённый порядок с неизвестной колонкой не ломает таблицу', () => {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ order: ['title', 'нет-такой', 'date', 'title', 42, 'open'], sizing: {} }),
    );
    render(<TableView />);
    const h = headers();
    expect(h.slice(0, 4)).toEqual(['', 'Название', 'Дата', 'Тип']);
    expect(h).toHaveLength(13);
    expect(screen.getByText('Первая')).toBeTruthy();
  });

  it('mergeOrder: новые колонки в конец, неизвестные и дубли отброшены, служебная первой', () => {
    const m = mergeOrder(['notes', 'zzz', 'notes', 'date']);
    expect(m.slice(0, 3)).toEqual(['open', 'notes', 'date']);
    expect(m).toHaveLength(15);
    expect(new Set(m).size).toBe(15);
    expect(mergeOrder('мусор')[0]).toBe('open');
  });

  it('Tab при редактировании идёт по новому порядку колонок', () => {
    render(<TableView />);
    const firstDateCell = () =>
      document.querySelector('.entry-row [data-col="date"] .cell-view') as HTMLElement;

    const dateEditor = () => document.querySelector('.cell-input[aria-label="Дата"]') as HTMLElement;

    // исходный порядок: Дата → Время
    fireEvent.click(firstDateCell());
    fireEvent.keyDown(dateEditor(), { key: 'Tab' });
    expect(screen.getByRole('textbox', { name: 'Время' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Время' }), { key: 'Escape' });

    // Время — после Названия: Дата → Название
    fireEvent.click(screen.getByRole('button', { name: 'Ниже: Время' }));
    fireEvent.click(firstDateCell());
    fireEvent.keyDown(dateEditor(), { key: 'Tab' });
    const title = screen.getByRole('textbox', { name: 'Название' }) as HTMLInputElement;
    // по умолчанию «сначала новые»: верхняя запись — 2-е число
    expect(title.value).toBe('Вторая');
    fireEvent.keyDown(title, { key: 'Tab' });
    expect(screen.getByRole('textbox', { name: 'Время' })).toBeTruthy();
  });
});

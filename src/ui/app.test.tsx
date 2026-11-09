// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { store } from '../store/store';
import { emptyDoc, newEntry } from '../model/entry';

vi.mock('../ods/parseLine', () => ({
  parseQuickLine: vi.fn((text: string) => ({
    entry: { title: 'Спектакль', date: '2026-12-12', timeStart: '11:00', timeEnd: '12:00', amount: 200, type: 'joint' },
    sourceName: 'Петя',
    issues: text.includes('?') ? ['дата под вопросом'] : [],
  })),
}));

import { App } from '../App';

beforeAll(async () => {
  await store.load();
});

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* нет хранилища */
  }
  store.replaceDoc(emptyDoc());
});

afterEach(() => cleanup());

describe('App', () => {
  it('рендерится и переключает вкладки', () => {
    render(<App />);
    expect(screen.getByRole('main', { name: 'Таблица' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Разделы' });
    fireEvent.click(within(nav).getByRole('button', { name: /Задачи/ }));
    expect(screen.getByRole('main', { name: 'Задачи' })).toBeTruthy();
    fireEvent.click(within(nav).getByRole('button', { name: /Итоги/ }));
    expect(screen.getByRole('main', { name: 'Итоги' })).toBeTruthy();
    fireEvent.click(within(nav).getByRole('button', { name: /Настройки/ }));
    expect(screen.getByText('Импорт из .ods')).toBeTruthy();
    fireEvent.click(within(nav).getByRole('button', { name: /Календарь/ }));
    expect(screen.getByRole('main', { name: 'Календарь' })).toBeTruthy();
    fireEvent.click(within(nav).getByRole('button', { name: /Деньги/ }));
    expect(screen.getByText('У клиентов', { selector: '.stat-label' })).toBeTruthy();
  });

  it('быстрый ввод создаёт запись и источник', () => {
    render(<App />);
    const input = screen.getByLabelText('Быстрый ввод');
    fireEvent.change(input, { target: { value: '12.12 спектакль 11-12 200 от Пети' } });
    // предпросмотр распознанного
    expect(screen.getByText('Спектакль')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    const doc = store.getDoc();
    expect(doc.entries).toHaveLength(1);
    const e = doc.entries[0];
    expect(e.title).toBe('Спектакль');
    expect(e.amount).toBe(200);
    expect(e.type).toBe('joint');
    expect(doc.sources).toHaveLength(1);
    expect(doc.sources[0].name).toBe('Петя');
    expect(e.sourceId).toBe(doc.sources[0].id);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('правка в карточке меняет store', () => {
    const e = newEntry({ title: 'Свадьба', date: '2030-05-01', status: 'booked', amount: 500 });
    act(() => store.upsertEntry(e));
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Разделы' });
    fireEvent.click(within(nav).getByRole('button', { name: /Задачи/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Канбан' }));
    fireEvent.click(screen.getByText('Свадьба'));
    const dialog = screen.getByRole('dialog');
    const title = within(dialog).getByLabelText('Название');
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Свадьба Анны' } });
    fireEvent.blur(title);
    expect(store.getDoc().entries[0].title).toBe('Свадьба Анны');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Отснято' }));
    const after = store.getDoc().entries[0];
    expect(after.status).toBe('shot');
    expect(after.history?.at(-1)?.text).toContain('Отснято');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Всё получено' }));
    expect(store.getDoc().entries[0].money).toEqual([expect.objectContaining({ amount: 500, where: 'owner' })]);
  });

  it('новая запись из карточки попадает в store только после «Создать»', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Новая запись' }));
    const dialog = screen.getByRole('dialog');
    const title = within(dialog).getByLabelText('Название');
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Зубной' } });
    fireEvent.blur(title);
    expect(store.getDoc().entries).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    expect(store.getDoc().entries.map((x) => x.title)).toEqual(['Зубной']);
  });
});

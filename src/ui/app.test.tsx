// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { store } from '../store/store';
import { emptyDoc, newEntry } from '../model/entry';

vi.mock('../ods/parseLine', () => ({
  parseQuickLine: vi.fn((text: string) => ({
    entry: { title: 'Встреча', date: '2026-12-12', timeStart: '11:00', timeEnd: '12:00', amount: 200, type: 'main' },
    money: true,
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
    fireEvent.change(input, { target: { value: '12.12 встреча 11-12 200 от Пети' } });
    // предпросмотр распознанного
    expect(screen.getByText('Встреча')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    const doc = store.getDoc();
    expect(doc.entries).toHaveLength(1);
    const e = doc.entries[0];
    expect(e.title).toBe('Встреча');
    expect(e.amount).toBe(200);
    expect(e.type).toBe('main'); // тип по умолчанию; источник тип не меняет
    expect(doc.sources).toHaveLength(1);
    expect(doc.sources[0].name).toBe('Петя');
    expect(e.sourceId).toBe(doc.sources[0].id);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('правка в карточке меняет store', () => {
    const e = newEntry({ title: 'Проект сайта', date: '2030-05-01', status: 'booked', amount: 500 });
    act(() => store.upsertEntry(e));
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Разделы' });
    fireEvent.click(within(nav).getByRole('button', { name: /Задачи/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Канбан' }));
    fireEvent.click(screen.getByText('Проект сайта'));
    const dialog = screen.getByRole('dialog');
    const title = within(dialog).getByLabelText('Название');
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Проект сайта Анны' } });
    fireEvent.blur(title);
    expect(store.getDoc().entries[0].title).toBe('Проект сайта Анны');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Сделано' }));
    const after = store.getDoc().entries[0];
    expect(after.status).toBe('shot');
    expect(after.history?.at(-1)?.text).toContain('Сделано');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Всё получено' }));
    expect(store.getDoc().entries[0].money).toEqual([expect.objectContaining({ amount: 500, where: 'owner' })]);
  });

  it('в карточке можно сразу завести новый источник и новый контакт; поля «Вид» нет', () => {
    const e = newEntry({ title: 'Проект сайта', date: '2030-05-01', status: 'booked', amount: 500 });
    act(() => store.upsertEntry(e));
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Разделы' });
    fireEvent.click(within(nav).getByRole('button', { name: /Задачи/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Канбан' }));
    fireEvent.click(screen.getByText('Проект сайта'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Вид')).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: '+ Новый источник' }));
    fireEvent.change(within(dialog).getByLabelText('Имя нового источника'), { target: { value: 'Петя' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить источник' }));
    const doc1 = store.getDoc();
    expect(doc1.sources.map((s) => s.name)).toEqual(['Петя']);
    expect(doc1.entries[0].sourceId).toBe(doc1.sources[0].id);

    fireEvent.click(within(dialog).getByRole('button', { name: '+ Новый контакт' }));
    fireEvent.change(within(dialog).getByPlaceholderText('Имя'), { target: { value: 'Анна' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    const doc2 = store.getDoc();
    expect(doc2.contacts.map((c) => c.name)).toEqual(['Анна']);
    expect(doc2.entries[0].contactId).toBe(doc2.contacts[0].id);
  });

  it('свой тип: добавить в настройках → есть в выборе типа карточки → запись окрашена его цветом', () => {
    const e = newEntry({ title: 'Курс по Excel', date: '2030-05-01', status: 'booked', amount: 300 });
    act(() => store.upsertEntry(e));
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Разделы' });
    fireEvent.click(within(nav).getByRole('button', { name: /Настройки/ }));
    expect(screen.getByText('Типы задач')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Название нового типа'), { target: { value: 'Обучение' } });
    fireEvent.change(screen.getByLabelText('Цвет нового типа'), { target: { value: '#ab47bc' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Добавить тип' }));
    const added = store.getDoc().settings.taskTypes.find((t) => t.name === 'Обучение')!;
    expect(added).toMatchObject({ color: '#ab47bc', money: true });
    expect(screen.getByLabelText('Цвет типа Обучение')).toBeTruthy();

    fireEvent.click(within(nav).getByRole('button', { name: /Задачи/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Канбан' }));
    fireEvent.click(screen.getByText('Курс по Excel'));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Обучение' }));
    expect(store.getDoc().entries[0].type).toBe(added.id);
    const card = dialog.querySelector('.entry-card') as HTMLElement;
    expect(card.style.getPropertyValue('--tc')).toBe('#ab47bc');
    // Тип с деньгами — поле суммы на месте.
    expect(within(dialog).queryByLabelText('Сумма, €')).toBeTruthy();
    // Тип без денег — поле суммы скрыто.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Личное' }));
    expect(within(dialog).queryByLabelText('Сумма, €')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Обучение' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Готово' }));
    const mini = screen.getByText('Курс по Excel').closest('.mini') as HTMLElement;
    expect(mini.style.getPropertyValue('--tc')).toBe('#ab47bc');
  });

  it('удаление типа: записи переводятся в выбранный тип, тип становится tombstone', () => {
    const doc = emptyDoc();
    doc.settings.taskTypes = [
      ...doc.settings.taskTypes,
      { id: 'edu', name: 'Обучение', color: '#ab47bc', money: true },
      { id: 'fam', name: 'Семья', color: '#123456', money: false },
    ];
    doc.entries = [
      newEntry({ type: 'edu', title: 'Курс 1' }),
      newEntry({ type: 'edu', title: 'Курс 2' }),
      newEntry({ type: 'edu', title: 'удалённая', deleted: true }),
    ];
    act(() => store.replaceDoc(doc));
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Разделы' });
    fireEvent.click(within(nav).getByRole('button', { name: /Настройки/ }));

    // Типы по умолчанию — такие же: их можно удалить.
    expect(screen.getByRole('button', { name: 'Удалить тип Личное' })).toBeTruthy();
    expect((screen.getByLabelText('С деньгами: Личное') as HTMLInputElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Удалить тип Обучение' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/2 записи этого типа/)).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'joint' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Перевести и удалить' }));
    const after = store.getDoc();
    expect(after.entries.filter((x) => !x.deleted).map((x) => x.type)).toEqual(['joint', 'joint']);
    expect(after.settings.taskTypes.find((t) => t.id === 'edu')).toMatchObject({ deleted: true });
    expect(screen.queryByLabelText('Цвет типа Обучение')).toBeNull();

    // Без записей — подтверждение и сразу tombstone.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Удалить тип Семья' }));
    expect(confirm).toHaveBeenCalled();
    expect(store.getDoc().settings.taskTypes.find((t) => t.id === 'fam')).toMatchObject({ deleted: true });

    // Тип по умолчанию «Основная работа» удаляется так же; записи — в выбранный тип.
    fireEvent.click(screen.getByRole('button', { name: 'Удалить тип Личное' }));
    expect(store.getDoc().settings.taskTypes.find((t) => t.id === 'personal')).toMatchObject({ deleted: true });
    fireEvent.click(screen.getByRole('button', { name: 'Удалить тип Основная работа' }));
    expect(store.getDoc().settings.taskTypes.find((t) => t.id === 'main')).toMatchObject({ deleted: true });

    // Последний тип удалить нельзя.
    const last = screen.getByRole('button', { name: 'Удалить тип Совместная работа' }) as HTMLButtonElement;
    expect(last.disabled).toBe(true);
    expect(screen.getByText(/последний тип — удалить его нельзя/)).toBeTruthy();
    confirm.mockRestore();
  });

  it('тип по умолчанию из настроек: новая запись из карточки', () => {
    const doc = emptyDoc();
    doc.settings.taskTypes = [...doc.settings.taskTypes, { id: 'edu', name: 'Обучение', color: '#ab47bc', money: true }];
    act(() => store.replaceDoc(doc));
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Разделы' });
    fireEvent.click(within(nav).getByRole('button', { name: /Настройки/ }));
    fireEvent.change(screen.getByLabelText('Тип по умолчанию'), { target: { value: 'edu' } });
    expect(store.getDoc().settings.defaultTypeId).toBe('edu');

    fireEvent.change(screen.getByLabelText('Тип для дел без денег'), { target: { value: 'joint' } });
    expect(store.getDoc().settings.defaultNoMoneyTypeId).toBe('joint');

    fireEvent.click(screen.getByRole('button', { name: 'Новая запись' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Обучение' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    expect(store.getDoc().entries.map((x) => x.type)).toEqual(['edu']);
  });

  it('запись неизвестного типа не роняет интерфейс', () => {
    act(() => store.upsertEntry(newEntry({ type: 'нет-такого', title: 'Странная', date: '2030-05-01', amount: 10 })));
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Разделы' });
    for (const tab of [/Задачи/, /Итоги/, /Календарь/, /Деньги/, /Таблица/]) {
      fireEvent.click(within(nav).getByRole('button', { name: tab }));
    }
    fireEvent.click(within(nav).getByRole('button', { name: /Задачи/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Канбан' }));
    fireEvent.click(screen.getByText('Странная'));
    const dialog = screen.getByRole('dialog');
    // Текущий (неизвестный) тип остаётся в выборе.
    expect(within(dialog).getByRole('button', { name: 'нет-такого' }).getAttribute('aria-pressed')).toBe('true');
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

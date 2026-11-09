// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { store } from '../store/store';
import { emptyDoc, newEntry } from '../model/entry';
import type { Entry } from '../model/types';
import { Picker, type PickerItem } from './Picker';
import { EntryCard } from './EntryCard';

beforeAll(async () => {
  await store.load();
});

beforeEach(() => {
  store.replaceDoc(emptyDoc());
});

afterEach(() => cleanup());

/** Picker со своим состоянием: список и выбранный id живут в обёртке. */
function Harness({
  kind,
  initial,
  onCreateSpy,
}: {
  kind: 'contact' | 'source';
  initial: PickerItem[];
  onCreateSpy?: (name: string, extra: { phone?: string }) => void;
}) {
  const [items, setItems] = useState(initial);
  const [value, setValue] = useState<string | undefined>();
  return (
    <div>
      <Picker
        kind={kind}
        label={kind === 'contact' ? 'Контакт' : 'Источник'}
        items={items}
        value={value}
        defaultSub={kind === 'source' ? 'посредник' : undefined}
        onChange={setValue}
        onCreate={(name, extra) => {
          onCreateSpy?.(name, extra);
          const id = 'new-' + name;
          setItems((l) => [...l, { id, label: name, sub: extra.phone }]);
          return id;
        }}
      />
      <output data-testid="value">{value ?? ''}</output>
      <button type="button">снаружи</button>
    </div>
  );
}

const SOURCES: PickerItem[] = [
  { id: 's1', label: 'Петя' },
  { id: 's2', label: 'Пётр Сергеевич' },
  { id: 's3', label: 'Агентство Луч' },
];
const CONTACTS: PickerItem[] = [
  { id: 'c1', label: 'Анна', sub: '+44 99 000 001', search: '+44 99 000 001' },
  { id: 'c2', label: 'Борис', sub: '+44 77 123 456', search: '+44 77 123 456' },
];

const value = () => screen.getByTestId('value').textContent;
const openPicker = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const search = (word: string) => screen.getByRole('combobox', { name: `Поиск: ${word}` });

describe('Picker', () => {
  it('до выбора — поле «Выбрать»; поиск фильтрует список по имени', () => {
    render(<Harness kind="source" initial={SOURCES} />);
    const trigger = screen.getByRole('button', { name: 'Источник: выбрать' });
    expect(trigger.textContent).toContain('Выбрать');
    openPicker('Источник: выбрать');
    const input = search('источник');
    expect(document.activeElement).toBe(input);
    expect(screen.getAllByRole('option')).toHaveLength(3);
    fireEvent.change(input, { target: { value: 'пе' } });
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['ППетя', 'ППётр Сергеевич', '+ Добавить «пе»']);
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0].id);
  });

  it('контакт ищется и по телефону', () => {
    render(<Harness kind="contact" initial={CONTACTS} />);
    openPicker('Контакт: выбрать');
    fireEvent.change(search('контакт'), { target: { value: '77 12' } });
    const opts = screen.getAllByRole('option');
    expect(opts[0].textContent).toContain('Борис');
    expect(opts.filter((o) => o.textContent?.includes('Анна'))).toHaveLength(0);
  });

  it('«+ Добавить «Петя»» создаёт источник и выбирает его; плашка с подписью «посредник»', () => {
    const spy = vi.fn();
    render(<Harness kind="source" initial={[]} onCreateSpy={spy} />);
    openPicker('Источник: выбрать');
    fireEvent.change(search('источник'), { target: { value: 'Петя' } });
    fireEvent.click(screen.getByRole('option', { name: '+ Добавить «Петя»' }));
    expect(spy).toHaveBeenCalledWith('Петя', {});
    expect(value()).toBe('new-Петя');
    const plate = screen.getByRole('group', { name: 'Источник' });
    expect(within(plate).getByText('Петя')).toBeTruthy();
    expect(within(plate).getByText('посредник')).toBeTruthy();
  });

  it('дубль по имени не создаётся — выбирается существующий', () => {
    const spy = vi.fn();
    render(<Harness kind="source" initial={SOURCES} onCreateSpy={spy} />);
    openPicker('Источник: выбрать');
    fireEvent.change(search('источник'), { target: { value: 'ПЕТЯ' } });
    // Точное совпадение есть — строки «+ Добавить» нет, Enter выбирает существующего.
    expect(screen.queryByRole('option', { name: /Добавить/ })).toBeNull();
    fireEvent.keyDown(search('источник'), { key: 'Enter' });
    expect(spy).not.toHaveBeenCalled();
    expect(value()).toBe('s1');
  });

  it('контакт: «+ Добавить» → мини-форма с телефоном → контакт создан и выбран', () => {
    const spy = vi.fn();
    render(<Harness kind="contact" initial={CONTACTS} onCreateSpy={spy} />);
    openPicker('Контакт: выбрать');
    fireEvent.change(search('контакт'), { target: { value: 'Вера' } });
    fireEvent.click(screen.getByRole('option', { name: '+ Добавить «Вера»' }));
    const form = screen.getByRole('group', { name: 'Новый контакт' });
    expect((within(form).getByLabelText('Имя') as HTMLInputElement).value).toBe('Вера');
    fireEvent.change(within(form).getByLabelText('Телефон (необязательно)'), { target: { value: '+44 11 222 333' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Сохранить' }));
    expect(spy).toHaveBeenCalledWith('Вера', { phone: '+44 11 222 333' });
    expect(value()).toBe('new-Вера');
    const plate = screen.getByRole('group', { name: 'Контакт' });
    expect(within(plate).getByText('+44 11 222 333')).toBeTruthy();
  });

  it('× убирает выбор и возвращает поле «Выбрать»', () => {
    render(<Harness kind="contact" initial={CONTACTS} />);
    openPicker('Контакт: выбрать');
    fireEvent.click(screen.getByRole('option', { name: /Анна/ }));
    expect(value()).toBe('c1');
    fireEvent.click(screen.getByRole('button', { name: 'Убрать контакт' }));
    expect(value()).toBe('');
    expect(screen.getByRole('button', { name: 'Контакт: выбрать' })).toBeTruthy();
  });

  it('клавиатура: ↓ и Enter выбирают, Esc закрывает, клик вне — закрывает', () => {
    render(<Harness kind="source" initial={SOURCES} />);
    openPicker('Источник: выбрать');
    fireEvent.keyDown(search('источник'), { key: 'Escape' });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(value()).toBe('');

    openPicker('Источник: выбрать');
    expect(screen.getByRole('combobox')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'снаружи' }));
    expect(screen.queryByRole('combobox')).toBeNull();

    openPicker('Источник: выбрать');
    const input = search('источник');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(value()).toBe('s2');
  });

  it('Enter на «+ Добавить» добавляет источник', () => {
    render(<Harness kind="source" initial={SOURCES} />);
    openPicker('Источник: выбрать');
    fireEvent.change(search('источник'), { target: { value: 'Ребята' } });
    fireEvent.keyDown(search('источник'), { key: 'Enter' });
    expect(value()).toBe('new-Ребята');
  });

  it('Esc в поиске не закрывает карточку', () => {
    const onClose = vi.fn();
    act(() => store.upsertEntry(newEntry({ title: 'Съёмка', amount: 100 })));
    render(<EntryCard id={store.getDoc().entries[0].id} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Источник: выбрать' }));
    fireEvent.keyDown(search('источник'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

describe('Карточка: разделы «Добавить ещё»', () => {
  const openCard = (patch: Partial<Entry> = {}) => {
    const e = newEntry({ title: 'Проект', date: '2030-05-01', amount: 300, ...patch });
    act(() => store.upsertEntry(e));
    render(<EntryCard id={e.id} onClose={() => {}} />);
    return e;
  };

  it('«+ Заметка» открывает поле заметки и исчезает из ряда; «Убрать» прячет раздел и очищает', () => {
    openCard();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Заметки')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '+ Заметка' }));
    const notes = within(dialog).getByLabelText('Заметки');
    expect(document.activeElement).toBe(notes);
    expect(within(dialog).queryByRole('button', { name: '+ Заметка' })).toBeNull();
    fireEvent.focus(notes);
    fireEvent.change(notes, { target: { value: 'взять штатив' } });
    fireEvent.blur(notes);
    expect(store.getDoc().entries[0].notes).toBe('взять штатив');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Убрать раздел «Заметка»' }));
    expect(store.getDoc().entries[0].notes).toBeUndefined();
    expect(within(dialog).queryByLabelText('Заметки')).toBeNull();
    expect(within(dialog).getByRole('button', { name: '+ Заметка' })).toBeTruthy();
  });

  it('у записи с заметкой и местом поля видны сразу, без кнопок', () => {
    openCard({ notes: 'позвонить заранее', location: 'Офис' });
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText('Заметки') as HTMLTextAreaElement).value).toBe('позвонить заранее');
    expect((within(dialog).getByLabelText('Место') as HTMLInputElement).value).toBe('Офис');
    expect(within(dialog).queryByRole('button', { name: '+ Заметка' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: '+ Место' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: '+ Категория' })).toBeTruthy();
  });

  it('«+ Оплата и инвойс» и сумма есть только у типа с деньгами', () => {
    openCard();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: '+ Оплата и инвойс' })).toBeTruthy();
    expect(within(dialog).getByLabelText('Сумма, €')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Личное' }));
    expect(within(dialog).queryByRole('button', { name: '+ Оплата и инвойс' })).toBeNull();
    expect(within(dialog).queryByLabelText('Сумма, €')).toBeNull();
    expect(within(dialog).queryByLabelText('№ инвойса')).toBeNull();
  });

  it('у выбранного контакта с телефоном — кнопки связи', () => {
    const doc = emptyDoc();
    doc.contacts = [
      { id: 'c1', name: 'Анна', phones: ['+44 99 000 001'], channels: [], createdAt: '', updatedAt: '' },
    ];
    act(() => store.replaceDoc(doc));
    openCard({ contactId: 'c1' });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('link', { name: 'Позвонить' }).getAttribute('href')).toBe('tel:+4499000001');
    expect(within(dialog).getByRole('link', { name: 'WhatsApp' })).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Telegram' })).toBeTruthy();
  });

  it('новая запись: «Создать» сохраняет поля из главного и из добавленных разделов', () => {
    const onClose = vi.fn();
    const draft = newEntry({ title: '', amount: undefined });
    render(<EntryCard draft={draft} onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    const type = (label: string, v: string) => {
      const el = within(dialog).getByLabelText(label);
      fireEvent.focus(el);
      fireEvent.change(el, { target: { value: v } });
      fireEvent.blur(el);
    };
    type('Что сделать', 'Свадьба');
    type('Сумма, €', '900');
    fireEvent.change(within(dialog).getByLabelText('Когда'), { target: { value: '2030-06-01' } });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Источник: выбрать' }));
    fireEvent.change(search('источник'), { target: { value: 'Петя' } });
    fireEvent.keyDown(search('источник'), { key: 'Enter' });

    fireEvent.click(within(dialog).getByRole('button', { name: '+ Место' }));
    type('Место', 'Ратуша');
    fireEvent.click(within(dialog).getByRole('button', { name: '+ Категория' }));
    type('Категория', 'проект');
    fireEvent.click(within(dialog).getByRole('button', { name: '+ Оплата и инвойс' }));
    type('№ инвойса', 'INV-7');
    fireEvent.click(within(dialog).getByRole('button', { name: '+ Заметка' }));
    type('Заметки', 'два фотографа');
    fireEvent.click(within(dialog).getByRole('button', { name: '+ Чек-лист' }));
    fireEvent.change(within(dialog).getByLabelText('Новый пункт'), { target: { value: 'Договор' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }));

    // До «Создать» в store только новый источник, записи нет.
    expect(store.getDoc().entries).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    expect(onClose).toHaveBeenCalled();
    const [saved] = store.getDoc().entries;
    const src = store.getDoc().sources.find((s) => s.name === 'Петя')!;
    expect(saved).toMatchObject({
      title: 'Свадьба',
      amount: 900,
      date: '2030-06-01',
      sourceId: src.id,
      location: 'Ратуша',
      category: 'проект',
      invoiceNo: 'INV-7',
      notes: 'два фотографа',
    });
    expect(saved.checklist.map((x) => x.text)).toEqual(['Договор']);
  });
});

import { describe, expect, test } from 'vitest';
import type { Source } from '../model/types';
import {
  buildMoney,
  findPayment,
  findSource,
  nameForms,
  nominativeName,
  parseDatePrefix,
  parseQuickLine,
  parseTimeCell,
} from './parseLine';
import type { ParseContext } from './types';

const petya: Source = {
  id: 's1',
  name: 'Петя',
  aliases: ['петя', 'пети', 'петей'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const ctx: ParseContext = { year: 2026, month: 12, sources: [], today: '2026-11-09' };
const galya: Source = { ...petya, id: 's2', name: 'Галя', aliases: [] };
const ctxS: ParseContext = { ...ctx, sources: [petya, galya] };
const q = (s: string, c: ParseContext = ctx) => parseQuickLine(s, c);

describe('parseQuickLine — пример из SPEC', () => {
  test('«12.12 спектакль 11-12 200 от Пети»', () => {
    const r = q('12.12 спектакль 11-12 200 от Пети');
    expect(r.entry).toMatchObject({
      date: '2026-12-12',
      timeStart: '11:00',
      timeEnd: '12:00',
      allDay: false,
      amount: 200,
      title: 'спектакль',
      category: 'спектакль',
      type: 'joint',
      kind: 'shoot',
      status: 'booked',
      money: [{ amount: 200, where: 'client' }],
    });
    expect(r.sourceName).toBe('Петя');
    expect(r.entry.sourceId).toBeUndefined();
  });

  test('источник из справочника даёт sourceId', () => {
    expect(q('12.12 спектакль 11-12 200 от Пети', ctxS).entry.sourceId).toBe('s1');
  });
});

describe('даты', () => {
  test.each([
    ['5.12 съёмка', '2026-12-05', undefined],
    ['05.12 съёмка', '2026-12-05', undefined],
    ['19-20.12 корпоратив', '2026-12-19', '2026-12-20'],
    ['13.12-14.12 Северный пляж', '2026-12-13', '2026-12-14'],
    ['11.12 - 13.12 выезд', '2026-12-11', '2026-12-13'],
    ['30.12-02.01 отпуск', '2026-12-30', '2027-01-02'],
    ['12-14 др стас', '2026-12-12', '2026-12-14'],
    ['30.11. ресепшн', '2026-11-30', undefined],
    ['27.12.корпоратив', '2026-12-27', undefined],
    ['26.08.2023 свадьба', '2023-08-26', undefined],
  ])('%s', (text, date, dateEnd) => {
    const r = q(text);
    expect(r.entry.date).toBe(date);
    expect(r.entry.dateEnd).toBe(dateEnd);
  });

  test('хвост «?» и «уточнить» → предварительно', () => {
    expect(q('29.12? свадьба').entry.dateTentative).toBe(true);
    expect(q('10.12??? квест').entry).toMatchObject({ date: '2026-12-10', dateTentative: true, title: 'квест' });
    expect(q('13.12 собор уточнить').entry.dateTentative).toBe(true);
    expect(q('13.12 собор').entry.dateTentative).toBe(false);
  });

  test('время в начале — не дата', () => {
    expect(q('11.00 встреча').entry.date).toBeUndefined();
    expect(q('17.30 созвон').entry.date).toBeUndefined();
  });

  test('дата другого месяца — ближайший год и пометка', () => {
    const r = q('12.05 свадьба');
    expect(r.entry.date).toBe('2027-05-12');
    expect(r.issues).toContain('Дата из другого месяца');
    expect(parseDatePrefix('14.12 Альфа', 2025, 2).date).toBe('2024-12-14');
  });

  test('«2-4 видео» под итогом листа — не диапазон дат', () => {
    expect(parseDatePrefix('2-4 короткие видео', 2025, 5, { allowBareRange: false }).date).toBeUndefined();
  });
});

describe('время', () => {
  test.each([
    ['1.12 съёмка 16.00-23.00', '16:00', '23:00', undefined],
    ['1.12 съёмка 13.00 - 18.00', '13:00', '18:00', undefined],
    ['1.12 съёмка 9.00 - 11.30, 13.30 - 15.30', '09:00', '15:30', '09:00–11:30, 13:30–15:30'],
    ['1.12 бар 19.3', '19:30', undefined, undefined],
    ['1.12 зубной 17.30', '17:30', undefined, undefined],
    ['1.12 клип 17.00 - 18. 00', '17:00', '18:00', undefined],
    ['1.12 вечеринка 20.00 - 24.00', '20:00', '00:00', undefined],
    ['1.12 съёмка 12 - 15.00', '12:00', '15:00', undefined],
  ])('%s', (text, s, e, note) => {
    const r = q(text);
    expect(r.entry.timeStart).toBe(s);
    expect(r.entry.timeEnd).toBe(e);
    expect(r.entry.timeNote).toBe(note);
  });

  test('слова вместо времени → timeNote', () => {
    expect(q('26.12 др в старом городе вечер').entry).toMatchObject({ timeNote: 'вечер', allDay: true });
    expect(q('6.12 съёмка утром 250').entry.timeNote).toBe('утром');
    expect(q('6.12 съёмка уточнить 250').entry.timeNote).toBe('уточнить');
  });

  test('ячейка времени при импорте', () => {
    expect(parseTimeCell('9.00 утра')).toMatchObject({ timeStart: '09:00' });
    expect(parseTimeCell('17.30 уточнить')).toMatchObject({ timeStart: '17:30', timeNote: 'уточнить' });
    expect(parseTimeCell('вечер').timeNote).toBe('вечер');
    expect(parseTimeCell('???').timeNote).toBe('уточнить');
    expect(parseTimeCell('13.30 lдень')).toMatchObject({ timeStart: '13:30' });
    expect(parseTimeCell('17.00 - ')).toMatchObject({ timeStart: '17:00' });
  });
});

describe('сумма и оплата', () => {
  test('сумма с € и без', () => {
    expect(q('1.12 съёмка €150').entry.amount).toBe(150);
    expect(q('1.12 съёмка 150 евро').entry.amount).toBe(150);
    expect(q('1.12 съёмка 16.00-18.00 350').entry.amount).toBe(350);
    expect(q('комиссия за 5-7 сентября -200').entry).toMatchObject({ amount: -200, kind: 'payment' });
  });

  test('оплачено и опечатки → owner', () => {
    for (const w of ['оплачено', 'оплчано', 'оплчаено', 'Оплачено']) {
      expect(q(`1.11 съёмка 300 ${w}`).entry.money).toEqual([{ amount: 300, where: 'owner' }]);
    }
    expect(q('1.11 съёмка 300 не оплачено').entry.money).toEqual([{ amount: 300, where: 'client' }]);
  });

  test('50 процентов → owner + client', () => {
    expect(q('1.11 съёмка 892 оплачено 50 процентов').entry.money).toEqual([
      { amount: 446, where: 'owner' },
      { amount: 446, where: 'client' },
    ]);
  });

  test('у Пети → intermediary с holderId', () => {
    const r = q('28.11 видео с петей 200 у Пети', ctxS);
    expect(r.entry.money).toEqual([{ amount: 200, where: 'intermediary', holderId: 's1' }]);
    expect(r.entry.type).toBe('joint');
  });

  test('способ оплаты', () => {
    expect(q('1.11 съёмка 150 нал').entry.money).toEqual([{ amount: 150, where: 'owner', method: 'cash' }]);
    expect(q('1.11 съёмка 150 револют').entry.money).toEqual([{ amount: 150, where: 'owner', method: 'revolut' }]);
    expect(q('1.11 съёмка 150 на счету').entry.money).toEqual([{ amount: 150, where: 'owner', method: 'bank' }]);
    expect(q('1.11 съёмка 150 счет').entry.money).toEqual([{ amount: 150, where: 'client', method: 'bank' }]);
  });

  test('ни оплаты, ни посредника → client', () => {
    expect(q('1.11 съёмка 150').entry.money).toEqual([{ amount: 150, where: 'client' }]);
  });

  test('частичная предоплата', () => {
    expect(findPayment('150 предоплата на революте уже').partialOwner).toBe(150);
    const p = findPayment('предоплата 150 в августе');
    expect(p).toMatchObject({ partialOwner: 150, partialElsewhere: true });
    expect(buildMoney(400, findPayment('150 предоплата на революте уже'))).toEqual([
      { amount: 150, where: 'owner', method: 'revolut' },
      { amount: 250, where: 'client', method: 'revolut' },
    ]);
    expect(buildMoney(300, p)).toEqual([{ amount: 300, where: 'client' }]);
    expect(findPayment('14.06 Предоплата за 1.09').partialOwner).toBeUndefined();
  });

  test('оплачено в <месяце> → accountingMonth (в прошлом)', () => {
    expect(q('3.12 корпоратив оплачено в феврале').entry.accountingMonth).toBe('2026-02');
    expect(q('3.12 корпоратив оплачено в ноябре').entry.accountingMonth).toBe('2026-11');
  });

  test('предоплата/сертификат — запись-оплата, деньги получены', () => {
    const r = q('предоплата за 15.12 100');
    expect(r.entry).toMatchObject({ kind: 'payment', amount: 100, money: [{ amount: 100, where: 'owner' }] });
    expect(q('13.12 сертификат на 300').entry.kind).toBe('payment');
  });

  test('инвойс', () => {
    expect(q('3.11 видео 200 инв 28').entry).toMatchObject({ invoiceNo: '28', amount: 200 });
    expect(q('25.01 аматус 150 инвойс 1').entry.invoiceNo).toBe('1');
  });
});

describe('источник', () => {
  test.each([
    ['26.12 фотодень С Петей 200', 'Петя'],
    ['19.12 фото от Гали 200', 'Галя'],
    ['21.12 видео через Галю 250', 'Галя'],
    ['31.12 свадьба от ребят 300', 'Ребята'],
    ['10.12 свадьба агенство 350', 'Агентство'],
    ['14.12 корпоратив от Коли 700', 'Коля'],
    ['20.12 свадьба от Оли 300', 'Оля'],
  ])('%s → %s', (text, name) => {
    const r = q(text, ctxS);
    expect(r.sourceName).toBe(name);
    expect(r.entry.type).toBe('joint');
  });

  test('«у Коли» без справочника — посредник держит деньги', () => {
    const r = q('3.12 свадьба 300 у Коли');
    expect(r.sourceName).toBe('Коля');
    expect(r.entry.money).toEqual([{ amount: 300, where: 'intermediary' }]);
  });

  test('имя без предлога — не источник («Петя др»)', () => {
    expect(findSource('6.05 Петя др')).toBeUndefined();
  });

  test('падежи', () => {
    expect(nominativeName('Коли', 'от')).toBe('Коля');
    expect(nominativeName('Оли', 'от')).toBe('Оля');
    expect(nominativeName('Гали', 'от')).toBe('Галя');
    expect(nominativeName('Техкода', 'от')).toBe('Техкод');
    expect(nominativeName('Таню', 'через')).toBe('Таня');
    expect(nameForms('Коля')).toEqual(expect.arrayContaining(['коля', 'коли', 'колей', 'колю']));
  });
});

describe('контакт', () => {
  test('телефон и имя рядом', () => {
    expect(q('3.12 др Анна 99000001 250').contact).toEqual({ name: 'Анна', phones: ['99000001'], channels: [] });
  });

  test('международный номер с пробелами и ватсап', () => {
    const c = q('28.12 детский др ватсап +7 985 421-11-38 250').contact!;
    expect(c.phones).toEqual(['+79854211138']);
    expect(c.channels).toEqual([{ kind: 'whatsapp', value: '+79854211138' }]);
  });

  test('ссылки и слова-каналы', () => {
    expect(q('1.12 портреты https://www.facebook.com/someone 250').contact!.channels).toEqual([
      { kind: 'facebook', value: 'https://www.facebook.com/someone' },
    ]);
    expect(q('1.12 пиццерия Вера инст 130').contact).toMatchObject({ name: 'Вера', channels: [{ kind: 'instagram' }] });
    expect(q('1.12 др телеграм 150').contact!.channels[0].kind).toBe('telegram');
    expect(q('18.12 др смс 97000002 250').contact!.channels).toEqual([{ kind: 'sms', value: '97000002' }]);
  });

  test('телефон не становится суммой', () => {
    expect(q('5.12 студия 99000003 150').entry.amount).toBe(150);
  });
});

describe('вид, тип, категория', () => {
  test('личное без суммы', () => {
    expect(q('19.12 зубной 17.30 - 18.30').entry).toMatchObject({ type: 'personal', kind: 'event', money: [] });
    expect(q('20.12 к рите').entry.type).toBe('personal');
  });

  test('работа без даты → work + accountingMonth', () => {
    expect(q('ретушь 700').entry).toMatchObject({ kind: 'work', amount: 700, accountingMonth: '2026-12', category: 'ретушь' });
    expect(q('обработка для Коли 100').entry).toMatchObject({ kind: 'work', type: 'joint' });
  });

  test('без обработки, фото/видео', () => {
    expect(q('17.12 театр 200 без обработки').entry).toMatchObject({ withEditing: false, title: 'театр' });
    expect(q('8.12 пифагор фото и видео 200').entry.media).toEqual(['photo', 'video']);
    expect(q('2.12 клип 450').entry.media).toEqual(['video']);
  });

  test('категории и синонимы', () => {
    expect(q('5.12 др 150').entry.category).toBe('день рождения');
    expect(q('5.12 детский др 350').entry.category).toBe('детский день рождения');
    expect(q('28.12 крещение 400').entry.category).toBe('крестины');
    expect(q('2.12 wedding 300').entry.category).toBe('свадьба');
    expect(q('5.12 корпоратив фото 300').entry.category).toBe('корпоратив');
  });

  test('статус по дате', () => {
    expect(q('1.11 съёмка 300 оплачено').entry.status).toBe('done');
    expect(q('1.11 съёмка 300').entry.status).toBe('delivered');
    expect(q('1.12 съёмка 300').entry.status).toBe('booked');
    expect(q('1.11 съёмка отмена').entry.status).toBe('cancelled');
  });
});

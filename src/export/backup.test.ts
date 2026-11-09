import { describe, expect, it } from 'vitest';
import { emptyDoc, newEntry } from '../model/entry';
import { exportBackup, parseBackup } from './backup';

describe('backup', () => {
  const doc = emptyDoc();
  doc.entries = [newEntry({ title: 'Альфа', date: '2026-06-01', amount: 300, money: [{ amount: 300, where: 'owner' }] })];

  it('round-trip', () => {
    const text = exportBackup(doc);
    const parsed = JSON.parse(text);
    expect(parsed.app).toBe('work-life-tracker');
    expect(typeof parsed.exportedAt).toBe('string');
    expect(parseBackup(text)).toEqual(doc);
  });

  it('принимает голый TrackerDoc', () => {
    expect(parseBackup(JSON.stringify(doc))).toEqual(doc);
  });

  it('понятные ошибки', () => {
    expect(() => parseBackup('не json')).toThrow(/не является JSON/);
    expect(() => parseBackup('[]')).toThrow(/нет данных трекера/);
    expect(() => parseBackup(JSON.stringify({ app: 'other', doc }))).toThrow(/другого приложения/);
    expect(() => parseBackup(JSON.stringify({ ...doc, schemaVersion: 2 }))).toThrow(/версия данных \(2\)/);
    expect(() => parseBackup(JSON.stringify({ ...doc, entries: {} }))).toThrow(/записи/);
    expect(() => parseBackup(JSON.stringify({ ...doc, settings: null }))).toThrow(/настроек/);
    expect(() => parseBackup(JSON.stringify({ foo: 1 }))).toThrow(/schemaVersion/);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessDay, businessMonth, businessYear, inPeriod, yearPeriod } from './period.ts';

const jst = (s: string) => Date.parse(`${s}+09:00`);

test('朝6時で日を区切る', () => {
  assert.equal(businessDay(jst('2024-03-02T05:59:59')), '2024-03-01');
  assert.equal(businessDay(jst('2024-03-02T06:00:00')), '2024-03-02');
  assert.equal(businessDay(jst('2024-03-01T23:00:00')), '2024-03-01');
});

test('月・年の境目も6時', () => {
  assert.equal(businessMonth(jst('2024-09-01T01:00:00')), '2024-08');
  assert.equal(businessMonth(jst('2024-09-01T06:00:00')), '2024-09');
  assert.equal(businessYear(jst('2025-01-01T02:00:00')), '2024');
  assert.equal(businessYear(jst('2025-01-01T06:00:00')), '2025');
});

test('期間は両端を含む。12月31日の対局も年に入る', () => {
  const y = yearPeriod(2024);
  assert.ok(inPeriod(jst('2024-01-01T06:00:00'), y));
  assert.ok(inPeriod(jst('2024-12-31T22:00:00'), y));
  assert.ok(inPeriod(jst('2025-01-01T03:00:00'), y));
  assert.ok(!inPeriod(jst('2024-01-01T05:00:00'), y));
  assert.ok(!inPeriod(jst('2025-01-01T06:00:00'), y));
  assert.ok(inPeriod(jst('2024-05-05T12:00:00'), {}));
  assert.ok(inPeriod(jst('2024-05-05T12:00:00'), { from: '2024-05-05' }));
  assert.ok(!inPeriod(jst('2024-05-05T12:00:00'), { to: '2024-05-04' }));
});

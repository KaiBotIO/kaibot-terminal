import { describe, expect, it } from 'bun:test';
import { toCsv, type CsvColumn } from '../csv';

interface Row {
  name: string | null;
  qty: number;
  note?: string;
}

const cols: CsvColumn<Row>[] = [
  { header: 'Name', value: (r) => r.name },
  { header: 'Qty', value: (r) => r.qty },
  { header: 'Note', value: (r) => r.note },
];

describe('toCsv', () => {
  it('renders header + rows joined with CRLF', () => {
    const csv = toCsv([{ name: 'BTC', qty: 2 }], cols);
    expect(csv).toBe('Name,Qty,Note\r\nBTC,2,');
  });

  it('quotes values containing commas', () => {
    const csv = toCsv([{ name: 'a,b', qty: 1 }], cols);
    expect(csv.split('\r\n')[1]).toBe('"a,b",1,');
  });

  it('doubles embedded quotes', () => {
    const csv = toCsv([{ name: 'say "hi"', qty: 1 }], cols);
    expect(csv.split('\r\n')[1]).toBe('"say ""hi""",1,');
  });

  it('quotes values containing newlines', () => {
    const csv = toCsv([{ name: 'a\nb', qty: 1 }], cols);
    expect(csv).toContain('"a\nb"');
  });

  it('renders null/undefined as empty fields', () => {
    const csv = toCsv([{ name: null, qty: 0 }], cols);
    expect(csv.split('\r\n')[1]).toBe(',0,');
  });

  it('serializes Date values as ISO strings', () => {
    const d = new Date('2026-01-15T12:30:00.000Z');
    const csv = toCsv([{ when: d }], [{ header: 'When', value: (r: { when: Date }) => r.when }]);
    expect(csv.split('\r\n')[1]).toBe('2026-01-15T12:30:00.000Z');
  });

  it('escapes headers too', () => {
    const csv = toCsv<Row>([], [{ header: 'P&L, net', value: (r) => r.qty }]);
    expect(csv).toBe('"P&L, net"');
  });
});

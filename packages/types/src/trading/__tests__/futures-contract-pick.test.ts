import { describe, expect, it } from 'bun:test';
import { isDatedContractOf, pickOrderContract } from '../futures-multipliers';

describe('pickOrderContract', () => {
  it('a close hits the contract the lineage holds, not the front of the day', () => {
    // Engine rolled U26 → Z26 while the position (opened on U26) is still on.
    expect(pickOrderContract({ root: 'MNQ', held: 'MNQU26', hint: 'MNQZ26', resolved: 'MNQZ26' }))
      .toEqual({ symbol: 'MNQU26', source: 'held' });
  });

  it('an entry follows the schedule front on the wire over the quote-volume pick (roll lag window)', () => {
    // Crossover started: live quote volume already favours Z26, the schedule
    // confirms two sessions later and the signal's bars are still U26.
    expect(pickOrderContract({ root: 'MNQ', hint: 'MNQU26', resolved: 'MNQZ26' }))
      .toEqual({ symbol: 'MNQU26', source: 'hint' });
  });

  it('without a hint the quote-volume pick stands (older engine, manual, TradingView)', () => {
    expect(pickOrderContract({ root: 'MES', resolved: 'MESZ26' }))
      .toEqual({ symbol: 'MESZ26', source: 'resolved' });
  });

  it('never trusts a candidate that is not a dated contract of the root', () => {
    expect(pickOrderContract({ root: 'MNQ', hint: 'MESU26', resolved: 'MNQ' }))
      .toEqual({ symbol: 'MNQ', source: 'root' });
    expect(pickOrderContract({ root: 'MNQ', held: 'BTC-PERPETUAL', hint: 'mnqz26' }))
      .toEqual({ symbol: 'MNQZ26', source: 'hint' });
  });

  it('isDatedContractOf', () => {
    expect(isDatedContractOf('MNQZ26', 'MNQ')).toBe(true);
    expect(isDatedContractOf('MNQZ26', 'MES')).toBe(false);
    expect(isDatedContractOf('MNQ', 'MNQ')).toBe(false);
  });
});

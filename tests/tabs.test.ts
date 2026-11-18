import { describe, expect, it } from 'vitest';
import { parseTab } from '../src/ui/tabs';

describe('parseTab', () => {
  it('認得四個分頁', () => {
    expect(parseTab('#radar')).toBe('radar');
    expect(parseTab('#stats')).toBe('stats');
    expect(parseTab('#settings')).toBe('settings');
  });

  it('不認得或空白時回到記錄頁', () => {
    expect(parseTab('')).toBe('record');
    expect(parseTab('#nope')).toBe('record');
  });
});

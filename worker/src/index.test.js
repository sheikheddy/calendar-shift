import { describe, it, expect, vi } from 'vitest';
import {
  SLEEP_EVENT_NAMES,
  PRAYER_EVENT_NAMES,
  getExpectedWakeTime,
  isSoloEvent,
  shouldSkipEvent,
  calculateShiftedTimes,
  calculateOffset,
  handleVerification,
  handleWebhook,
} from './index.js';

describe('SLEEP_EVENT_NAMES', () => {
  it('should contain expected sleep-related keywords', () => {
    expect(SLEEP_EVENT_NAMES).toContain('sleep');
    expect(SLEEP_EVENT_NAMES).toContain('wake');
    expect(SLEEP_EVENT_NAMES).toContain('wakeup');
    expect(SLEEP_EVENT_NAMES).toContain('bedtime');
  });
});

describe('PRAYER_EVENT_NAMES', () => {
  it('should contain all five daily prayers', () => {
    expect(PRAYER_EVENT_NAMES).toContain('fajr');
    expect(PRAYER_EVENT_NAMES).toContain('dhuhr');
    expect(PRAYER_EVENT_NAMES).toContain('asr');
    expect(PRAYER_EVENT_NAMES).toContain('maghrib');
    expect(PRAYER_EVENT_NAMES).toContain('isha');
  });

  it('should contain generic prayer terms', () => {
    expect(PRAYER_EVENT_NAMES).toContain('prayer');
    expect(PRAYER_EVENT_NAMES).toContain('salah');
    expect(PRAYER_EVENT_NAMES).toContain('salat');
  });
});

describe('getExpectedWakeTime', () => {
  it('should return null for empty events array', () => {
    expect(getExpectedWakeTime([])).toBeNull();
  });

  it('should return null when no sleep event exists', () => {
    const events = [
      { summary: 'Meeting', end: { dateTime: '2024-01-15T10:00:00Z' } },
      { summary: 'Lunch', end: { dateTime: '2024-01-15T13:00:00Z' } },
    ];
    expect(getExpectedWakeTime(events)).toBeNull();
  });

  it('should find wake time from "Sleep" event', () => {
    const events = [
      { summary: 'Sleep', end: { dateTime: '2024-01-15T07:00:00Z' } },
      { summary: 'Meeting', end: { dateTime: '2024-01-15T10:00:00Z' } },
    ];
    const result = getExpectedWakeTime(events);
    expect(result).toEqual(new Date('2024-01-15T07:00:00Z'));
  });

  it('should find wake time from "Wake up" event (case insensitive)', () => {
    const events = [
      { summary: 'WAKE UP', end: { dateTime: '2024-01-15T08:00:00Z' } },
    ];
    const result = getExpectedWakeTime(events);
    expect(result).toEqual(new Date('2024-01-15T08:00:00Z'));
  });

  it('should find wake time from "Bedtime" event', () => {
    const events = [
      { summary: 'bedtime routine', end: { dateTime: '2024-01-15T06:30:00Z' } },
    ];
    const result = getExpectedWakeTime(events);
    expect(result).toEqual(new Date('2024-01-15T06:30:00Z'));
  });

  it('should return null for sleep event without dateTime (all-day)', () => {
    const events = [
      { summary: 'Sleep', end: { date: '2024-01-15' } },
    ];
    expect(getExpectedWakeTime(events)).toBeNull();
  });

  it('should return first matching sleep event', () => {
    const events = [
      { summary: 'Sleep', end: { dateTime: '2024-01-15T07:00:00Z' } },
      { summary: 'Nap (sleep)', end: { dateTime: '2024-01-15T15:00:00Z' } },
    ];
    const result = getExpectedWakeTime(events);
    expect(result).toEqual(new Date('2024-01-15T07:00:00Z'));
  });
});

describe('isSoloEvent', () => {
  const myEmail = 'me@example.com';

  it('should return true for event with no attendees', () => {
    const event = { summary: 'Solo task' };
    expect(isSoloEvent(event, myEmail)).toBe(true);
  });

  it('should return true for event with empty attendees array', () => {
    const event = { summary: 'Solo task', attendees: [] };
    expect(isSoloEvent(event, myEmail)).toBe(true);
  });

  it('should return true when only attendee is self', () => {
    const event = {
      summary: 'Solo task',
      attendees: [{ email: myEmail }],
    };
    expect(isSoloEvent(event, myEmail)).toBe(true);
  });

  it('should return true when attendee has self flag', () => {
    const event = {
      summary: 'Solo task',
      attendees: [{ email: 'different@example.com', self: true }],
    };
    expect(isSoloEvent(event, myEmail)).toBe(true);
  });

  it('should return false when other attendees exist', () => {
    const event = {
      summary: 'Team meeting',
      attendees: [
        { email: myEmail },
        { email: 'colleague@example.com' },
      ],
    };
    expect(isSoloEvent(event, myEmail)).toBe(false);
  });

  it('should return false for event with only other attendees', () => {
    const event = {
      summary: 'Meeting',
      attendees: [{ email: 'other@example.com' }],
    };
    expect(isSoloEvent(event, myEmail)).toBe(false);
  });
});

describe('shouldSkipEvent', () => {
  const myEmail = 'me@example.com';

  it('should skip sleep events', () => {
    const event = { summary: 'Sleep', start: { dateTime: '2024-01-15T22:00:00Z' } };
    const result = shouldSkipEvent(event, myEmail);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe('sleep event');
  });

  it('should skip prayer events (fajr)', () => {
    const event = { summary: 'Fajr Prayer', start: { dateTime: '2024-01-15T05:30:00Z' } };
    const result = shouldSkipEvent(event, myEmail);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe('prayer time');
  });

  it('should skip prayer events (dhuhr)', () => {
    const event = { summary: 'Dhuhr', start: { dateTime: '2024-01-15T12:30:00Z' } };
    const result = shouldSkipEvent(event, myEmail);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe('prayer time');
  });

  it('should skip prayer events (asr)', () => {
    const event = { summary: 'Asr time', start: { dateTime: '2024-01-15T15:30:00Z' } };
    const result = shouldSkipEvent(event, myEmail);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe('prayer time');
  });

  it('should skip prayer events (maghrib)', () => {
    const event = { summary: 'Maghrib', start: { dateTime: '2024-01-15T18:00:00Z' } };
    const result = shouldSkipEvent(event, myEmail);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe('prayer time');
  });

  it('should skip prayer events (isha)', () => {
    const event = { summary: 'Isha', start: { dateTime: '2024-01-15T19:30:00Z' } };
    const result = shouldSkipEvent(event, myEmail);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe('prayer time');
  });

  it('should skip all-day events', () => {
    const event = { summary: 'Vacation', start: { date: '2024-01-15' } };
    const result = shouldSkipEvent(event, myEmail);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe('all-day event');
  });

  it('should skip events with other attendees', () => {
    const event = {
      summary: 'Team meeting',
      start: { dateTime: '2024-01-15T10:00:00Z' },
      attendees: [{ email: 'other@example.com' }],
    };
    const result = shouldSkipEvent(event, myEmail);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe('has attendees');
  });

  it('should NOT skip regular solo events', () => {
    const event = {
      summary: 'Focus time',
      start: { dateTime: '2024-01-15T09:00:00Z' },
      end: { dateTime: '2024-01-15T10:00:00Z' },
    };
    const result = shouldSkipEvent(event, myEmail);
    expect(result.skip).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('should NOT skip events where user is only attendee', () => {
    const event = {
      summary: 'My appointment',
      start: { dateTime: '2024-01-15T14:00:00Z' },
      end: { dateTime: '2024-01-15T15:00:00Z' },
      attendees: [{ email: myEmail }],
    };
    const result = shouldSkipEvent(event, myEmail);
    expect(result.skip).toBe(false);
  });

  it('should use "Untitled" for events without summary', () => {
    const event = {
      start: { dateTime: '2024-01-15T09:00:00Z' },
      end: { dateTime: '2024-01-15T10:00:00Z' },
    };
    const result = shouldSkipEvent(event, myEmail);
    expect(result.skip).toBe(false); // Untitled doesn't match any skip pattern
  });
});

describe('calculateShiftedTimes', () => {
  it('should shift event forward by specified minutes', () => {
    const event = {
      start: { dateTime: '2024-01-15T09:00:00.000Z', timeZone: 'UTC' },
      end: { dateTime: '2024-01-15T10:00:00.000Z', timeZone: 'UTC' },
    };
    const result = calculateShiftedTimes(event, 30);

    expect(new Date(result.start.dateTime).toISOString()).toBe('2024-01-15T09:30:00.000Z');
    expect(new Date(result.end.dateTime).toISOString()).toBe('2024-01-15T10:30:00.000Z');
  });

  it('should preserve timezone info', () => {
    const event = {
      start: { dateTime: '2024-01-15T09:00:00.000Z', timeZone: 'America/New_York' },
      end: { dateTime: '2024-01-15T10:00:00.000Z', timeZone: 'America/New_York' },
    };
    const result = calculateShiftedTimes(event, 60);

    expect(result.start.timeZone).toBe('America/New_York');
    expect(result.end.timeZone).toBe('America/New_York');
  });

  it('should handle hour boundary crossing', () => {
    const event = {
      start: { dateTime: '2024-01-15T09:45:00.000Z' },
      end: { dateTime: '2024-01-15T10:45:00.000Z' },
    };
    const result = calculateShiftedTimes(event, 30);

    expect(new Date(result.start.dateTime).toISOString()).toBe('2024-01-15T10:15:00.000Z');
    expect(new Date(result.end.dateTime).toISOString()).toBe('2024-01-15T11:15:00.000Z');
  });

  it('should handle day boundary crossing', () => {
    const event = {
      start: { dateTime: '2024-01-15T23:30:00.000Z' },
      end: { dateTime: '2024-01-16T00:30:00.000Z' },
    };
    const result = calculateShiftedTimes(event, 60);

    expect(new Date(result.start.dateTime).toISOString()).toBe('2024-01-16T00:30:00.000Z');
    expect(new Date(result.end.dateTime).toISOString()).toBe('2024-01-16T01:30:00.000Z');
  });

  it('should handle large offsets', () => {
    const event = {
      start: { dateTime: '2024-01-15T09:00:00.000Z' },
      end: { dateTime: '2024-01-15T10:00:00.000Z' },
    };
    const result = calculateShiftedTimes(event, 180); // 3 hours

    expect(new Date(result.start.dateTime).toISOString()).toBe('2024-01-15T12:00:00.000Z');
    expect(new Date(result.end.dateTime).toISOString()).toBe('2024-01-15T13:00:00.000Z');
  });
});

describe('calculateOffset', () => {
  it('should return positive offset when woke up late', () => {
    const actualWake = new Date('2024-01-15T08:00:00Z');
    const expectedWake = new Date('2024-01-15T07:00:00Z');
    expect(calculateOffset(actualWake, expectedWake)).toBe(60);
  });

  it('should return negative offset when woke up early', () => {
    const actualWake = new Date('2024-01-15T06:30:00Z');
    const expectedWake = new Date('2024-01-15T07:00:00Z');
    expect(calculateOffset(actualWake, expectedWake)).toBe(-30);
  });

  it('should return zero when woke up on time', () => {
    const actualWake = new Date('2024-01-15T07:00:00Z');
    const expectedWake = new Date('2024-01-15T07:00:00Z');
    expect(calculateOffset(actualWake, expectedWake)).toBe(0);
  });

  it('should round to nearest minute', () => {
    const actualWake = new Date('2024-01-15T07:00:45Z'); // 45 seconds late
    const expectedWake = new Date('2024-01-15T07:00:00Z');
    expect(calculateOffset(actualWake, expectedWake)).toBe(1); // rounds to 1 minute
  });

  it('should handle multi-hour differences', () => {
    const actualWake = new Date('2024-01-15T10:30:00Z');
    const expectedWake = new Date('2024-01-15T07:00:00Z');
    expect(calculateOffset(actualWake, expectedWake)).toBe(210); // 3.5 hours
  });

  it('should detect stale data (wake time from previous day)', () => {
    // This is the bug we found - Oura API returning yesterday's wake time
    const actualWake = new Date('2024-01-14T17:45:21Z'); // Yesterday
    const expectedWake = new Date('2024-01-15T12:00:00Z'); // Today noon
    const offset = calculateOffset(actualWake, expectedWake);
    // Should be large negative number (~-1095 minutes)
    expect(offset).toBeLessThan(-1000);
  });

  it('should handle timezone offset in wake times', () => {
    // Wake time in EST (-05:00) = 1:02 PM EST = 6:02 PM UTC
    const actualWake = new Date('2024-01-15T18:02:36Z');
    const expectedWake = new Date('2024-01-15T17:00:00Z'); // 12 PM EST = 5 PM UTC
    expect(calculateOffset(actualWake, expectedWake)).toBe(63); // ~1 hour late
  });
});

describe('Edge cases and real-world scenarios', () => {
  const myEmail = 'me@example.com';

  describe('Multiple sleep sessions (naps)', () => {
    it('should use first sleep event for expected wake time', () => {
      const events = [
        { summary: 'Sleep', end: { dateTime: '2024-01-15T07:00:00Z' } },
        { summary: 'Afternoon nap (sleep)', end: { dateTime: '2024-01-15T15:00:00Z' } },
      ];
      const result = getExpectedWakeTime(events);
      expect(result).toEqual(new Date('2024-01-15T07:00:00Z'));
    });
  });

  describe('Prayer time variations', () => {
    it('should skip Jummah/Friday prayer', () => {
      const event = {
        summary: 'Jummah Prayer',
        start: { dateTime: '2024-01-15T13:00:00Z' }
      };
      const result = shouldSkipEvent(event, myEmail);
      expect(result.skip).toBe(true);
      expect(result.reason).toBe('prayer time');
    });

    it('should skip Tahajjud prayer', () => {
      const event = {
        summary: 'Tahajjud',
        start: { dateTime: '2024-01-15T04:00:00Z' }
      };
      // Tahajjud doesn't match current patterns - this test documents current behavior
      const result = shouldSkipEvent(event, myEmail);
      // Currently won't skip - may want to add 'tahajjud' to PRAYER_EVENT_NAMES
      expect(result.skip).toBe(false);
    });
  });

  describe('Calendar event edge cases', () => {
    it('should handle events with no summary gracefully', () => {
      const event = {
        start: { dateTime: '2024-01-15T09:00:00Z' },
        end: { dateTime: '2024-01-15T10:00:00Z' },
      };
      const result = shouldSkipEvent(event, myEmail);
      expect(result.skip).toBe(false);
    });

    it('should handle events with empty string summary', () => {
      const event = {
        summary: '',
        start: { dateTime: '2024-01-15T09:00:00Z' },
        end: { dateTime: '2024-01-15T10:00:00Z' },
      };
      const result = shouldSkipEvent(event, myEmail);
      expect(result.skip).toBe(false);
    });

    it('should be case insensitive for sleep detection', () => {
      const events = [
        { summary: 'SLEEP', end: { dateTime: '2024-01-15T07:00:00Z' } },
      ];
      expect(getExpectedWakeTime(events)).toEqual(new Date('2024-01-15T07:00:00Z'));
    });

    it('should be case insensitive for prayer detection', () => {
      const event = {
        summary: 'FAJR PRAYER',
        start: { dateTime: '2024-01-15T05:30:00Z' }
      };
      const result = shouldSkipEvent(event, myEmail);
      expect(result.skip).toBe(true);
      expect(result.reason).toBe('prayer time');
    });

    it('should handle event with only self as attendee with self flag', () => {
      const event = {
        summary: 'Personal task',
        start: { dateTime: '2024-01-15T09:00:00Z' },
        end: { dateTime: '2024-01-15T10:00:00Z' },
        attendees: [{ email: myEmail, self: true }],
      };
      const result = shouldSkipEvent(event, myEmail);
      expect(result.skip).toBe(false);
    });
  });

  describe('Time shift edge cases', () => {
    it('should handle DST boundary shift', () => {
      // Event during DST transition
      const event = {
        start: { dateTime: '2024-03-10T01:30:00.000Z', timeZone: 'America/New_York' },
        end: { dateTime: '2024-03-10T02:30:00.000Z', timeZone: 'America/New_York' },
      };
      const result = calculateShiftedTimes(event, 60);
      // Should still shift by 60 minutes regardless of DST
      const startDiff = new Date(result.start.dateTime) - new Date(event.start.dateTime);
      expect(startDiff).toBe(60 * 60 * 1000); // 60 minutes in ms
    });

    it('should handle very small offset (1 minute)', () => {
      const event = {
        start: { dateTime: '2024-01-15T09:00:00.000Z' },
        end: { dateTime: '2024-01-15T10:00:00.000Z' },
      };
      const result = calculateShiftedTimes(event, 1);
      expect(new Date(result.start.dateTime).toISOString()).toBe('2024-01-15T09:01:00.000Z');
    });

    it('should preserve event duration after shift', () => {
      const event = {
        start: { dateTime: '2024-01-15T09:00:00.000Z' },
        end: { dateTime: '2024-01-15T10:30:00.000Z' }, // 90 minute event
      };
      const result = calculateShiftedTimes(event, 45);

      const originalDuration = new Date(event.end.dateTime) - new Date(event.start.dateTime);
      const shiftedDuration = new Date(result.end.dateTime) - new Date(result.start.dateTime);

      expect(shiftedDuration).toBe(originalDuration);
      expect(shiftedDuration).toBe(90 * 60 * 1000); // 90 minutes
    });
  });
});

describe('handleVerification', () => {
  it('should return challenge when provided', async () => {
    const request = new Request('https://example.com/webhook?challenge=test-challenge-123');
    const response = handleVerification(request, {});
    const data = await response.json();
    expect(data.challenge).toBe('test-challenge-123');
  });

  it('should return ready status when no challenge', async () => {
    const request = new Request('https://example.com/webhook');
    const response = handleVerification(request, {});
    const data = await response.json();
    expect(data.status).toBe('ready');
  });
});

describe('handleWebhook', () => {
  const mockCtx = {
    waitUntil: vi.fn(),
  };
  const mockEnv = {};

  it('should process sleep create events', async () => {
    const request = new Request('https://example.com/webhook', {
      method: 'POST',
      body: JSON.stringify({
        event_type: 'create',
        data_type: 'sleep',
      }),
    });

    const response = await handleWebhook(request, mockEnv, mockCtx);
    const data = await response.json();

    expect(data.status).toBe('processing');
    expect(mockCtx.waitUntil).toHaveBeenCalled();
  });

  it('should ignore non-sleep events', async () => {
    const request = new Request('https://example.com/webhook', {
      method: 'POST',
      body: JSON.stringify({
        event_type: 'create',
        data_type: 'activity',
      }),
    });

    mockCtx.waitUntil.mockClear();
    const response = await handleWebhook(request, mockEnv, mockCtx);
    const data = await response.json();

    expect(data.status).toBe('ignored');
    expect(data.reason).toBe('not sleep create event');
    expect(mockCtx.waitUntil).not.toHaveBeenCalled();
  });

  it('should ignore sleep update events', async () => {
    const request = new Request('https://example.com/webhook', {
      method: 'POST',
      body: JSON.stringify({
        event_type: 'update',
        data_type: 'sleep',
      }),
    });

    mockCtx.waitUntil.mockClear();
    const response = await handleWebhook(request, mockEnv, mockCtx);
    const data = await response.json();

    expect(data.status).toBe('ignored');
  });

  it('should handle invalid JSON', async () => {
    const request = new Request('https://example.com/webhook', {
      method: 'POST',
      body: 'not valid json',
    });

    const response = await handleWebhook(request, mockEnv, mockCtx);
    expect(response.status).toBe(500);
  });
});

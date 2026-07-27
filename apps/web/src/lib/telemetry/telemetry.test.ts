import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getTelemetrySnapshot,
  setTelemetryEnabled,
  subscribeTelemetry,
  track,
} from './telemetry';

/**
 * These test a promise, not a feature. The privacy claim in the settings dialog
 * says counts only, opt-in only, nothing transmitted — so each of those is
 * pinned here, where a future change that quietly adds a payload or flips the
 * default has to break a test to land.
 */
describe('telemetry', () => {
  beforeEach(() => {
    localStorage.clear();
    setTelemetryEnabled(false);
  });

  it('is off until the user turns it on', () => {
    expect(getTelemetrySnapshot().enabled).toBe(false);
  });

  it('records nothing while it is off', () => {
    track('query.run');
    track('query.run');
    expect(getTelemetrySnapshot().counts).toEqual({});
  });

  it('counts events once enabled', () => {
    setTelemetryEnabled(true);
    track('query.run');
    track('query.run');
    track('chart.create');
    expect(getTelemetrySnapshot().counts).toEqual({ 'query.run': 2, 'chart.create': 1 });
  });

  it('deletes the counts when the user opts out', () => {
    setTelemetryEnabled(true);
    track('query.run');
    setTelemetryEnabled(false);
    expect(getTelemetrySnapshot()).toEqual({ enabled: false, counts: {} });
  });

  it('survives a reload', () => {
    setTelemetryEnabled(true);
    track('file.import');
    const stored: unknown = JSON.parse(localStorage.getItem('workbench-telemetry') ?? '{}');
    expect(stored).toEqual({ enabled: true, counts: { 'file.import': 1 } });
  });

  it('stores nothing but event names and integers', () => {
    setTelemetryEnabled(true);
    track('query.run');
    const raw = localStorage.getItem('workbench-telemetry') ?? '';
    const parsed = JSON.parse(raw) as { counts: Record<string, unknown> };
    for (const value of Object.values(parsed.counts)) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('never makes a network request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    setTelemetryEnabled(true);
    track('query.run');
    track('dashboard.export');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('notifies subscribers so the settings dialog stays in step', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTelemetry(listener);
    setTelemetryEnabled(true);
    track('query.run');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('hands back a stable snapshot between changes, as useSyncExternalStore needs', () => {
    setTelemetryEnabled(true);
    expect(getTelemetrySnapshot()).toBe(getTelemetrySnapshot());
  });

  it('degrades to a no-op rather than throwing when storage is unavailable', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => {
      setTelemetryEnabled(true);
      track('query.run');
    }).not.toThrow();
    setItem.mockRestore();
  });
});

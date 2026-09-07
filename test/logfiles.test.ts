import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asSoqlDate, buildLogFileQuery, formatBytes, validateEventTypes } from '../src/events/logfiles.ts';

describe('buildLogFileQuery', () => {
  it('asks for the named types, one interval, and nothing else by default', () => {
    const query = buildLogFileQuery({ eventTypes: ['Login', 'ApexExecution'], interval: 'Daily' });

    assert.match(query, /EventType IN \('Login', 'ApexExecution'\)/);
    assert.match(query, /Interval = 'Daily'/);
    assert.doesNotMatch(query, /LogDate [<>]=/);
  });

  it('bounds the dates when asked, as the start of each day', () => {
    const query = buildLogFileQuery({
      eventTypes: ['Login'],
      interval: 'Hourly',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
    });

    assert.match(query, /LogDate >= 2026-09-01T00:00:00Z/);
    assert.match(query, /LogDate <= 2026-09-07T00:00:00Z/);
    assert.match(query, /Interval = 'Hourly'/);
  });

  it('refuses a type name that could leave the literal or the file name', () => {
    // The name goes into a SOQL string and into a path, so a quote or a separator in it is
    // either a broken query or a file written somewhere else.
    assert.throws(() => validateEventTypes(["Login') OR Id != null OR ('"]), /letters, digits and underscores/);
    assert.throws(() => validateEventTypes(['../etc/passwd']), /letters, digits and underscores/);
    assert.deepEqual(validateEventTypes(['ApexRestApi', 'URI', 'Some_Future_Type']), [
      'ApexRestApi',
      'URI',
      'Some_Future_Type',
    ]);
  });

  it('refuses a date that is not a calendar date', () => {
    assert.throws(() => asSoqlDate('yesterday', 'start-date'), /--start-date must be a date/);
    assert.throws(() => asSoqlDate('2026-9-1', 'end-date'), /--end-date must be a date/);
  });
});

describe('formatBytes', () => {
  it('picks the unit a reader would', () => {
    assert.equal(formatBytes(30 * 1024), '30 KB');
    assert.equal(formatBytes(412 * 1024 * 1024), '412 MB');
    assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024), '1.5 GB');
  });
});

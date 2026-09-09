import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { SfError } from '@salesforce/core';
import { formatBytes } from '../../../events/logfiles.ts';
import {
  hasHourlyFiles,
  INVENTORY_QUERY,
  summarizeInventory,
  type EventTypeInventory,
  type InventoryRecord,
} from '../../../events/inventory.ts';

export type EventTypeSummary = EventTypeInventory;

/**
 * Every later command needs to know which EventTypes an org actually has, and no two orgs have
 * the same set: it depends on the edition, on which Shield features are licensed, and on what
 * has happened in the org in the retention window. Asking the org is the only reliable answer,
 * so nothing here carries a list of EventTypes.
 */
export default class Discover extends SfCommand<EventTypeSummary[]> {
  public static readonly summary =
    'List the EventTypes this org has logs for, with how many files, how large, and which days.';

  public static readonly description = `Queries EventLogFile and groups by EventType, so the output describes the org in front of you rather than a list someone wrote down. Each line is a type with its file count, its total size and the first and last day it covers; an org that keeps hourly files shows those on their own lines.

Requires the View Event Log Files permission and an org that generates event log files: Shield and the Event Monitoring add-on do so by default, and a Developer Edition or trial org has to opt in under Setup > Event Monitoring Settings, keeping one day. An org that generates none returns nothing, which is not an error.`;

  public static readonly examples = [
    '<%= config.bin %> <%= command.id %> --target-org my-org',
    '<%= config.bin %> <%= command.id %> --target-org my-org --json',
  ];

  public static readonly flags = {
    'target-org': Flags.requiredOrg(),
  };

  public async run(): Promise<EventTypeSummary[]> {
    const { flags } = await this.parse(Discover);
    const connection = flags['target-org'].getConnection();

    let records: InventoryRecord[];

    try {
      records = (await connection.query<InventoryRecord>(INVENTORY_QUERY)).records;
    } catch (error) {
      // The two failures worth separating: the object is not visible to this user, and everything
      // else. Telling them apart saves the reader from checking permissions they already have.
      const message = error instanceof Error ? error.message : String(error);

      throw new SfError(`Could not read EventLogFile in this org: ${message}`, 'EventLogFileUnavailable', [
        'Check that the user has the View Event Log Files permission.',
        'Check that the org generates event log files: Shield and the Event Monitoring add-on do by default; a Developer Edition or trial org opts in under Setup > Event Monitoring Settings.',
      ]);
    }

    const summaries = summarizeInventory(records);

    if (summaries.length === 0) {
      this.log('No event log files in this org, or none visible to this user.');
      return summaries;
    }

    // The interval column only earns its place in an org that has more than one.
    const showInterval = hasHourlyFiles(summaries);
    const width = Math.max(...summaries.map((s) => s.eventType.length));
    const totalFiles = summaries.reduce((sum, s) => sum + s.files, 0);
    const totalBytes = summaries.reduce((sum, s) => sum + s.bytes, 0);

    for (const summary of summaries) {
      const span = summary.earliest === summary.latest ? summary.latest : `${summary.earliest} to ${summary.latest}`;
      const interval = showInterval ? `  ${summary.interval.padEnd(6)}` : '';

      this.log(
        `${summary.eventType.padEnd(width)}${interval}  ${String(summary.files).padStart(7)}  ${formatBytes(summary.bytes).padStart(7)}  ${span}`
      );
    }

    this.log(
      `${new Set(summaries.map((s) => s.eventType)).size} EventTypes, ${totalFiles} files, ${formatBytes(totalBytes)}`
    );

    return summaries;
  }
}

import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { SfError } from '@salesforce/core';

export type EventTypeSummary = {
  eventType: string;
  files: number;
};

/**
 * Every later command needs to know which EventTypes an org actually has, and no two orgs have
 * the same set: it depends on the edition, on which Shield features are licensed, and on what
 * has happened in the org in the retention window. Asking the org is the only reliable answer,
 * so nothing here carries a list of EventTypes.
 */
export default class Discover extends SfCommand<EventTypeSummary[]> {
  public static readonly summary = 'List the EventTypes this org has logs for, and how many files each one has.';

  public static readonly description = `Queries EventLogFile and groups by EventType, so the output describes the org in front of you rather than a list someone wrote down.

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

    let records: Array<{ EventType: string; cnt: number }>;

    try {
      const result = await connection.query<{ EventType: string; cnt: number }>(
        'SELECT EventType, COUNT(Id) cnt FROM EventLogFile GROUP BY EventType ORDER BY EventType'
      );
      records = result.records;
    } catch (error) {
      // The two failures worth separating: the object is not visible to this user, and everything
      // else. Telling them apart saves the reader from checking permissions they already have.
      const message = error instanceof Error ? error.message : String(error);

      throw new SfError(`Could not read EventLogFile in this org: ${message}`, 'EventLogFileUnavailable', [
        'Check that the user has the View Event Log Files permission.',
        'Check that the org generates event log files: Shield and the Event Monitoring add-on do by default; a Developer Edition or trial org opts in under Setup > Event Monitoring Settings.',
      ]);
    }

    // The query asks for ORDER BY EventType and the org ignores it: a run against an org with 34
    // types came back in neither alphabetical nor case-insensitive order, so the ordering is the
    // platform's own and not something to rely on. Sorting here is what makes the list readable.
    const summaries = records
      .map((record) => ({
        eventType: record.EventType,
        files: record.cnt,
      }))
      .sort((a, b) => a.eventType.localeCompare(b.eventType));

    if (summaries.length === 0) {
      this.log('No event log files in this org, or none visible to this user.');
      return summaries;
    }

    const width = Math.max(...summaries.map((s) => s.eventType.length));
    const total = summaries.reduce((sum, s) => sum + s.files, 0);

    for (const summary of summaries) {
      this.log(`${summary.eventType.padEnd(width)}  ${String(summary.files).padStart(7)}`);
    }

    this.log(`${summaries.length} EventTypes, ${total} files`);

    return summaries;
  }
}

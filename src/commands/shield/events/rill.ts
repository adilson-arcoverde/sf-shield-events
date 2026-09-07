import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { SfError } from '@salesforce/core';
import { writeRillProject, type RillArtifacts } from '../../../events/project.ts';
import { withDuckDB } from '../../../events/tables.ts';

export type { RillArtifacts };

/**
 * Writes a Rill project over the tables that `extract` produced.
 *
 * The project is written into the same directory as the tables, so the models read them by
 * relative name and the whole directory can be moved or shared as one thing.
 */
export default class Rill extends SfCommand<RillArtifacts[]> {
  public static readonly summary = 'Generate a Rill project from extracted event tables.';

  public static readonly description = `Reads each Parquet table in the input directory, works out what every column is for, and writes a Rill model, metrics view and dashboard for it.

This is optional. The tables are already queryable with DuckDB through the shield.sql that "extract" writes; Rill adds a point-and-click explorer over the same files, and needs Rill installed.

Column roles come from the data. A column that parses as a number everywhere gets a total and an average, a column that parses as a timestamp can be the time axis, a column with few distinct values becomes a dimension, and one with a distinct value per row gets counted rather than grouped. No column name is special, so an event type this tool has never seen still produces a usable dashboard.

Then run "rill start" in the input directory.`;

  public static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --input-dir ./out',
  ];

  public static readonly flags = {
    'input-dir': Flags.directory({
      summary: 'Directory holding the Parquet tables written by "shield events extract".',
      default: 'output',
      exists: true,
    }),
  };

  public async run(): Promise<RillArtifacts[]> {
    const { flags } = await this.parse(Rill);
    const directory = flags['input-dir'];

    const { tables, built, skipped } = await withDuckDB((connection) => writeRillProject(connection, directory));

    if (tables.length === 0) {
      throw new SfError(`No Parquet tables in ${directory}.`, 'NothingToBuild', [
        'Run "sf shield events extract" first, or point --input-dir at where its output went.',
      ]);
    }

    for (const table of skipped) {
      this.warn(`${table} has no rows, skipping.`);
    }

    for (const artifact of built) {
      const axis = artifact.timeseries ? `time axis on ${artifact.timeseries}` : 'no time axis';
      this.log(`${artifact.eventType}: ${artifact.dimensions} dimensions, ${artifact.measures} measures, ${axis}`);

      if (artifact.emptyColumns > 0) {
        this.log(`  ${artifact.emptyColumns} columns were empty in this extract and were left out`);
      }
    }

    this.log(`\nRill project written to ${directory}. Run: rill start ${directory}`);

    return built;
  }
}

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { stringify as toYaml } from 'yaml';
import { buildExplore, buildMetricsView, buildModel, profileColumns } from './rill.ts';
import { sampleTable } from './tables.ts';

/** Rows read to decide what each column is for. */
export const PROFILE_SAMPLE_ROWS = 20_000;

export type RillArtifacts = {
  eventType: string;
  dimensions: number;
  measures: number;
  timeseries?: string;
  /** Columns left out because nothing in the sample filled them. */
  emptyColumns: number;
};

/**
 * Writes a Rill project over every Parquet table in a directory, and says what it wrote.
 *
 * This is the whole of what the `rill` command does apart from talking to the terminal, kept
 * here so that a test can write a project and hand it to a real Rill to validate.
 */
export async function writeRillProject(
  connection: DuckDBConnection,
  directory: string
): Promise<{ tables: string[]; built: RillArtifacts[]; skipped: string[] }> {
  const tables = (await readdir(directory)).filter((name) => name.endsWith('.parquet'));

  if (tables.length === 0) {
    return { tables, built: [], skipped: [] };
  }

  for (const folder of ['models', 'metrics', 'dashboards']) {
    await mkdir(join(directory, folder), { recursive: true });
  }

  // Rill reads every .sql file under the project as a model, and the directory also holds the
  // DuckDB views script and the ready-made queries, which are not models and do not parse as
  // ones. Telling Rill to leave them alone keeps the two ways of opening the directory apart.
  await writeFile(
    join(directory, 'rill.yaml'),
    toYaml({
      compiler: 'rillv1',
      display_name: 'Shield Event Monitoring',
      ignore_paths: ['/shield.sql', '/queries'],
    }),
    'utf8'
  );

  const built: RillArtifacts[] = [];
  const skipped: string[] = [];

  for (const table of tables) {
    const eventType = basename(table, '.parquet');
    // A few thousand rows say what kind of value a column holds as well as a few million, and
    // these tables run to gigabytes.
    const rows = await sampleTable(connection, join(directory, table), PROFILE_SAMPLE_ROWS);

    if (rows.length === 0) {
      skipped.push(table);
      continue;
    }

    const profiles = profileColumns(Object.keys(rows[0]), rows);
    const modelName = `${eventType}_model`;
    const metricsName = `${eventType}_metrics`;
    const metricsView = buildMetricsView(modelName, `${eventType} events`, profiles);

    await writeFile(join(directory, 'models', `${modelName}.yaml`), toYaml(buildModel(table)), 'utf8');
    await writeFile(join(directory, 'metrics', `${metricsName}.yaml`), toYaml(metricsView), 'utf8');
    await writeFile(
      join(directory, 'dashboards', `${eventType}_explore.yaml`),
      toYaml(buildExplore(metricsName, `${eventType} explorer`)),
      'utf8'
    );

    built.push({
      eventType,
      dimensions: (metricsView.dimensions as unknown[]).length,
      measures: (metricsView.measures as unknown[]).length,
      timeseries: metricsView.timeseries as string | undefined,
      emptyColumns: profiles.filter((profile) => profile.role === 'empty').length,
    });
  }

  return { tables, built, skipped };
}

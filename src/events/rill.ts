/**
 * Turns an extracted table into a Rill project, inferring what each column is for from the data
 * rather than from its name.
 *
 * The implementation this replaced carried three lists: the columns that make good measures and
 * how to aggregate each, the columns that could serve as a time axis, and a regular expression
 * that grouped one org's URLs into families. Anything outside those lists produced a dashboard
 * with a single COUNT(*) and no time axis, which is most of the event types Salesforce offers
 * and all of the ones added after the lists were written.
 *
 * So nothing here knows a column name. A column that parses as a number everywhere is something
 * to aggregate. A column that parses as a timestamp can be the time axis. A column with few
 * distinct values describes rows, and one with a distinct value per row identifies them, which
 * is worth counting but useless to group by.
 */
export type ColumnRole = 'timestamp' | 'numeric' | 'dimension' | 'identifier' | 'empty';

export type ColumnProfile = {
  name: string;
  role: ColumnRole;
  /** How many distinct non-empty values were seen. */
  distinct: number;
  /** How many rows carried a value. */
  filled: number;
  /**
   * How a timestamp column is written. Only an ISO column can serve as a Rill time axis: DuckDB
   * reads the packed form as a number, and a number is not a time axis.
   */
  timestampFormat?: 'iso' | 'packed';
};

/** Above this share of distinct values a column describes rows one by one, not in groups. */
const IDENTIFIER_DISTINCT_SHARE = 0.5;

/** Below this many distinct values a column stays a dimension whatever its share. */
const DIMENSION_MAXIMUM_DISTINCT = 50;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * Salesforce writes some timestamps packed into digits, as in 20260907120000.000. Those parse as
 * numbers, so without this they would be summed and averaged, and the total of a million
 * timestamps means nothing. The test is on the shape of the value, not on the name of the
 * column.
 */
const PACKED_TIMESTAMP = /^(\d{4})(\d{2})(\d{2})\d{6}(\.\d+)?$/;

function isPackedTimestamp(value: string): boolean {
  const parts = PACKED_TIMESTAMP.exec(value);

  if (!parts) {
    return false;
  }

  const [, year, month, day] = parts;

  return Number(year) >= 1970 && Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31;
}

/**
 * Reads the roles of every column from the rows themselves.
 * @param header The column names, in order.
 * @param rows The parsed rows.
 * @returns One profile per column, in the same order.
 */
export function profileColumns(header: string[], rows: Array<Record<string, string>>): ColumnProfile[] {
  return header.map((name) => {
    const values = rows.map((row) => row[name] ?? '').filter((value) => value !== '');
    const distinct = new Set(values).size;

    if (values.length === 0) {
      return { name, role: 'empty' as const, distinct: 0, filled: 0 };
    }

    if (values.every((value) => ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value)))) {
      return { name, role: 'timestamp' as const, distinct, filled: values.length, timestampFormat: 'iso' as const };
    }

    if (values.every(isPackedTimestamp)) {
      return { name, role: 'timestamp' as const, distinct, filled: values.length, timestampFormat: 'packed' as const };
    }

    if (values.every((value) => value.trim() !== '' && Number.isFinite(Number(value)))) {
      return { name, role: 'numeric' as const, distinct, filled: values.length };
    }

    const share = distinct / values.length;
    const role =
      distinct > DIMENSION_MAXIMUM_DISTINCT && share > IDENTIFIER_DISTINCT_SHARE ? 'identifier' : 'dimension';

    return { name, role, distinct, filled: values.length };
  });
}

/** Turns SOME_COLUMN_NAME into "Some Column Name" for a dashboard label. */
export function displayName(column: string): string {
  return column
    .toLowerCase()
    .split('_')
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * A Rill model over an extracted Parquet file.
 *
 * The file is already typed, so there is nothing to detect and no malformed row to skip: a
 * Parquet file either reads or it does not. The model is not materialised, because that would
 * copy every table into Rill's own database, and a Parquet file is already the fast form.
 * @param parquetFileName The file name, relative to the project directory.
 */
export function buildModel(parquetFileName: string): Record<string, unknown> {
  return {
    type: 'model',
    connector: 'duckdb',
    sql: `select * from '${parquetFileName}'\n`,
  };
}

/**
 * A metrics view whose dimensions and measures come from the profiles.
 *
 * Every numeric column gets a sum and an average, because which one matters depends on whether
 * the column counts things or measures them, and the data cannot say which. Both are cheap and
 * a reader picks. Identifier columns get a distinct count instead of a dimension.
 */
export function buildMetricsView(modelName: string, title: string, profiles: ColumnProfile[]): Record<string, unknown> {
  // A numeric column with few distinct values is groupable as well as summable: status codes,
  // API versions and HTTP method codes all parse as numbers and all describe rows. Type
  // inference alone cannot tell those from a duration, so a low cardinality numeric column
  // becomes both a dimension and a measure and the reader picks.
  const dimensions = profiles
    .filter(
      (profile) =>
        profile.role === 'dimension' || (profile.role === 'numeric' && profile.distinct <= DIMENSION_MAXIMUM_DISTINCT)
    )
    .map((profile) => ({ name: profile.name, display_name: displayName(profile.name), column: profile.name }));

  const measures: Array<Record<string, unknown>> = [
    { name: 'total_events', display_name: 'Total events', expression: 'COUNT(*)', format_preset: 'humanize' },
  ];

  for (const profile of profiles.filter((p) => p.role === 'identifier')) {
    measures.push({
      name: `distinct_${profile.name.toLowerCase()}`,
      display_name: `Distinct ${displayName(profile.name)}`,
      expression: `COUNT(DISTINCT ${profile.name})`,
      format_preset: 'humanize',
    });
  }

  for (const profile of profiles.filter((p) => p.role === 'numeric')) {
    for (const aggregation of ['sum', 'avg'] as const) {
      measures.push({
        name: `${aggregation}_${profile.name.toLowerCase()}`,
        display_name: `${aggregation === 'sum' ? 'Total' : 'Average'} ${displayName(profile.name)}`,
        // TRY_CAST because one unparseable value in a day of logs should not fail the measure.
        expression: `${aggregation.toUpperCase()}(TRY_CAST(${profile.name} AS DOUBLE))`,
        format_preset: 'humanize',
      });
    }
  }

  const view: Record<string, unknown> = {
    version: 1,
    type: 'metrics_view',
    display_name: title,
    connector: 'duckdb',
    model: modelName,
    dimensions,
    measures,
  };

  // Only an ISO column can be the axis. A packed timestamp is still excluded from the measures,
  // which is the point of recognising it, but DuckDB would read it as a number and Rill cannot
  // put a number on a time axis.
  const axes = profiles.filter((profile) => profile.role === 'timestamp' && profile.timestampFormat === 'iso');

  if (axes.length > 0) {
    // The column with the most distinct values is the one that moves per event rather than per
    // file, which is what a time axis wants.
    view.timeseries = axes.reduce((best, candidate) => (candidate.distinct > best.distinct ? candidate : best)).name;
  }

  return view;
}

/** An explore dashboard over the metrics view, showing everything it defines. */
export function buildExplore(metricsViewName: string, title: string): Record<string, unknown> {
  return {
    version: 1,
    type: 'explore',
    display_name: title,
    metrics_view: metricsViewName,
    dimensions: '*',
    measures: '*',
  };
}

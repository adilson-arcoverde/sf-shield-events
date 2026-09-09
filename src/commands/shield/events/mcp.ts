import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { SfError } from '@salesforce/core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createShieldServer, DEFAULT_ROW_LIMIT, openExtraction } from '../../../events/mcp.ts';
import { withDuckDB } from '../../../events/tables.ts';

/**
 * Serves an extraction directory to an MCP client over stdio.
 *
 * The process is the server: the client starts it, talks JSON-RPC on its stdin and stdout, and
 * ends it by closing the pipe. Nothing may be printed to stdout except protocol messages, so
 * every line meant for a person goes to stderr.
 */
export default class Mcp extends SfCommand<void> {
  public static readonly summary = 'Serve extracted event tables to an MCP client.';

  public static readonly description = `Starts a Model Context Protocol server over the tables that "extract" wrote, on standard input and output, so an assistant can list the event types, learn what each column is for, run the ready-made questions and ask its own.

The server is read-only. Only a single SELECT statement is accepted, DuckDB is confined to the extraction directory so no other file on the machine can be read, and every answer is capped at --row-limit rows. The rows are still unredacted production logs, and the client is usually a model running elsewhere: point this at an extraction you would be willing to paste into that model.

Add it to an MCP client as a stdio server running "sf shield events mcp --input-dir <directory>".`;

  public static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --input-dir ./out --row-limit 50',
  ];

  public static readonly enableJsonFlag = false;

  public static readonly flags = {
    'input-dir': Flags.directory({
      summary: 'Directory holding the Parquet tables written by "shield events extract".',
      default: 'output',
      exists: true,
    }),
    'row-limit': Flags.integer({
      summary: 'Most rows a single answer may carry.',
      default: DEFAULT_ROW_LIMIT,
      min: 1,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Mcp);
    const directory = flags['input-dir'];
    const version = this.config.plugins.get('sf-shield-events')?.version ?? '0.0.0';

    await withDuckDB(async (connection) => {
      const tables = await openExtraction(connection, directory);

      if (tables.length === 0) {
        throw new SfError(`No Parquet tables in ${directory}.`, 'NothingToServe', [
          'Run "sf shield events extract" first, or point --input-dir at where its output went.',
        ]);
      }

      const server = createShieldServer(connection, directory, tables, { rowLimit: flags['row-limit'], version });
      const transport = new StdioServerTransport();

      this.logToStderr(
        `Serving ${tables.length} tables from ${directory} over stdio, ${flags['row-limit']} rows per answer.`
      );

      // The command lives as long as the client keeps the pipe open. The DuckDB connection is
      // closed by `withDuckDB` once the transport ends, whichever way it ends.
      await new Promise<void>((resolve, reject) => {
        server.server.onclose = () => resolve();
        server.server.onerror = (error) => reject(error);
        for (const signal of ['SIGINT', 'SIGTERM'] as const) {
          process.once(signal, () => void server.close().then(resolve, reject));
        }
        server.connect(transport).catch(reject);
      });
    });
  }
}

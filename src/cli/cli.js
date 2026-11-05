/**
 * Admin command line. It opens the data file directly (no running server
 * or API key needed) and goes through the same service layer as the API,
 * so every validation rule applies here too.
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { AppError, ValidationError } from '../errors.js';
import { exportCsv, exportJson, importLinks, parseImport } from '../io/importExport.js';
import { createRuntime } from '../runtime.js';
import { FileStore } from '../storage/fileStore.js';

const USAGE = `Usage: shortlink <command> [options]

Commands:
  create <url>     Create a short link
                     --alias <name>  --ttl <seconds>  --expires <ISO time>
                     --max-clicks <n>  --password <text>  --tag <tag> (repeatable)
                     --redirect <301|302|307>  --disabled
  list             List links
                     --tag <tag>  --status <active|disabled|expired|exhausted>
                     --q <text>  --sort <field>  --page <n>  --page-size <n>
  stats <code>     Show click statistics    --from <YYYY-MM-DD>  --to <YYYY-MM-DD>
  import <file>    Import links             --format <json|csv>  --dry-run
                     --on-conflict <skip|error|overwrite>
  export           Export all links         --format <json|csv>  --output <file>
  compact          Rewrite the data file without its history

Global options:
  --data-file <path>   Data file to work on (default: SHORTLINK_DATA_FILE)
  --json               Print machine-readable JSON (create, list, stats, import)
  --help, --version

Settings are read from the same SHORTLINK_* environment variables as the server.
`;

/** A mistake in how the command was invoked (exit code 2). */
class UsageError extends Error {}

const OPTIONS = /** @type {const} */ ({
  'data-file': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  alias: { type: 'string' },
  ttl: { type: 'string' },
  expires: { type: 'string' },
  'max-clicks': { type: 'string' },
  password: { type: 'string' },
  tag: { type: 'string', multiple: true },
  redirect: { type: 'string' },
  disabled: { type: 'boolean' },
  status: { type: 'string' },
  q: { type: 'string' },
  sort: { type: 'string' },
  page: { type: 'string' },
  'page-size': { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  format: { type: 'string' },
  'dry-run': { type: 'boolean' },
  'on-conflict': { type: 'string' },
  output: { type: 'string' },
});

/** Options each command understands, besides the global ones. */
const COMMAND_OPTIONS = Object.freeze({
  create: ['alias', 'ttl', 'expires', 'max-clicks', 'password', 'tag', 'redirect', 'disabled'],
  list: ['tag', 'status', 'q', 'sort', 'page', 'page-size'],
  stats: ['from', 'to'],
  import: ['format', 'dry-run', 'on-conflict'],
  export: ['format', 'output'],
  compact: [],
});
const GLOBAL_OPTIONS = ['data-file', 'json', 'help', 'version'];

/**
 * @param {string | undefined} value
 * @param {string} option
 * @returns {number | undefined}
 */
function integerOption(value, option) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`--${option} must be a whole number (got "${value}")`);
  return Number(value);
}

/**
 * @param {string[]} positionals
 * @param {number} count
 * @param {string} what
 */
function expectPositionals(positionals, count, what) {
  if (positionals.length !== count) throw new UsageError(`Expected ${what}`);
}

/**
 * @param {Array<Record<string, unknown>>} links
 * @returns {string}
 */
function formatTable(links) {
  const rows = [
    ['CODE', 'STATUS', 'CLICKS', 'EXPIRES', 'URL'],
    ...links.map((link) => [link.code, link.status, link.clicks, link.expiresAt ?? '-', link.url].map(String)),
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()).join('\n');
}

/**
 * @param {import('../service/statsReport.js').StatsReport} report
 * @returns {string}
 */
function formatStats(report) {
  const lines = [
    `code:            ${report.code}`,
    `total clicks:    ${report.totalClicks}`,
    `clicks in range: ${report.clicksInRange}`,
    `unique visitors: ${report.uniqueVisitors}`,
    `last click:      ${report.lastClickAt ?? '-'}`,
  ];
  if (report.days.length > 0) {
    lines.push('', 'per day:');
    for (const day of report.days) lines.push(`  ${day.date}  ${day.clicks} clicks, ${day.uniqueVisitors} visitors`);
  }
  if (report.referrers.length > 0) {
    lines.push('', 'referrers:');
    for (const entry of report.referrers) lines.push(`  ${entry.referrer}  ${entry.clicks}`);
  }
  if (report.userAgents.length > 0) {
    lines.push('', 'user agents:');
    for (const entry of report.userAgents) lines.push(`  ${entry.family}  ${entry.clicks}`);
  }
  return lines.join('\n');
}

/**
 * Run one CLI invocation.
 * @param {string[]} argv arguments after the program name
 * @param {{ stdout?: (text: string) => void, stderr?: (text: string) => void, env?: Record<string, string | undefined>, clock?: import('../clock.js').Clock }} [io]
 * @returns {Promise<number>} the exit code: 0 success, 1 failure, 2 usage error
 */
export async function run(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => void process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => void process.stderr.write(text));
  const print = (/** @type {unknown} */ value) =>
    stdout(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);

  /** @type {import('../runtime.js').Runtime | undefined} */
  let runtime;
  try {
    /** @type {ReturnType<typeof parseArgs<{ options: typeof OPTIONS, allowPositionals: true }>>} */
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    } catch (err) {
      throw new UsageError(/** @type {Error} */ (err).message);
    }
    const { values, positionals } = parsed;
    if (values.version) {
      const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
      print(manifest.version);
      return 0;
    }
    const [command, ...args] = positionals;
    if (values.help || command === 'help' || command === undefined) {
      stdout(USAGE);
      return command === undefined && !values.help ? 2 : 0;
    }
    if (!Object.hasOwn(COMMAND_OPTIONS, command)) throw new UsageError(`Unknown command "${command}"`);
    const allowed = [...GLOBAL_OPTIONS, ...COMMAND_OPTIONS[/** @type {keyof typeof COMMAND_OPTIONS} */ (command)]];
    const stray = Object.keys(values).find((name) => !allowed.includes(name));
    if (stray !== undefined) throw new UsageError(`Option --${stray} does not apply to "${command}"`);

    const env = { ...(io.env ?? process.env) };
    if (values['data-file'] !== undefined) {
      env.SHORTLINK_STORE = 'file';
      env.SHORTLINK_DATA_FILE = values['data-file'];
    }
    const config = loadConfig(env);
    if (config.store !== 'file') {
      throw new UsageError('The CLI works on a data file: pass --data-file or set SHORTLINK_STORE=file');
    }
    runtime = createRuntime(config, { clock: io.clock });
    const { service, store } = runtime;

    switch (command) {
      case 'create': {
        expectPositionals(args, 1, 'exactly one URL: shortlink create <url>');
        const link = await service.createLink({
          url: args[0],
          alias: values.alias,
          ttlSeconds: integerOption(values.ttl, 'ttl'),
          expiresAt: values.expires,
          maxClicks: integerOption(values['max-clicks'], 'max-clicks'),
          password: values.password,
          tags: values.tag,
          redirectType: integerOption(values.redirect, 'redirect'),
          enabled: values.disabled ? false : undefined,
        });
        print(values.json ? link : link.shortUrl);
        return 0;
      }
      case 'list': {
        expectPositionals(args, 0, 'no arguments: shortlink list [options]');
        const page = service.listLinks({
          tag: values.tag?.join(','),
          status: values.status,
          q: values.q,
          sort: values.sort,
          page: values.page,
          pageSize: values['page-size'],
        });
        if (values.json) print(page);
        else print(`${formatTable(page.items)}\n\npage ${page.page} of ${Math.max(page.totalPages, 1)}, ${page.total} link(s)`);
        return 0;
      }
      case 'stats': {
        expectPositionals(args, 1, 'exactly one code: shortlink stats <code>');
        const report = service.getStats(args[0], { from: values.from, to: values.to });
        print(values.json ? report : formatStats(report));
        return 0;
      }
      case 'import': {
        expectPositionals(args, 1, 'exactly one file: shortlink import <file>');
        const format = values.format ?? (args[0].toLowerCase().endsWith('.csv') ? 'csv' : 'json');
        if (format !== 'json' && format !== 'csv') throw new UsageError('--format must be json or csv');
        /** @type {string} */
        let text;
        try {
          text = fs.readFileSync(args[0], 'utf8');
        } catch (err) {
          throw new ValidationError(`Cannot read ${args[0]}: ${/** @type {Error} */ (err).message}`, { code: 'file_unreadable' });
        }
        const summary = await importLinks(service, parseImport(text, format), {
          onConflict: /** @type {any} */ (values['on-conflict']),
          dryRun: values['dry-run'],
        });
        if (values.json) {
          print(summary);
        } else {
          print(
            `${summary.dryRun ? 'dry run: ' : ''}${summary.created} created, ${summary.overwritten} overwritten, ` +
              `${summary.skipped} skipped, ${summary.failed} failed`,
          );
          for (const entry of summary.errors) stderr(`record ${entry.index + 1}: ${entry.error.message}\n`);
        }
        return summary.failed === 0 ? 0 : 1;
      }
      case 'export': {
        expectPositionals(args, 0, 'no arguments: shortlink export [options]');
        const format = values.format ?? (values.output?.toLowerCase().endsWith('.csv') ? 'csv' : 'json');
        if (format !== 'json' && format !== 'csv') throw new UsageError('--format must be json or csv');
        const text = format === 'csv' ? exportCsv(store) : exportJson(store, service.clock.now());
        if (values.output === undefined) stdout(text);
        // Exports contain password hashes: keep the file private.
        else fs.writeFileSync(values.output, text, { mode: 0o600 });
        return 0;
      }
      default: {
        expectPositionals(args, 0, 'no arguments: shortlink compact');
        const result = /** @type {FileStore} */ (store).compact();
        print(
          values.json
            ? result
            : `compacted: ${result.recordsBefore} -> ${result.recordsAfter} records, ${result.bytesBefore} -> ${result.bytesAfter} bytes`,
        );
        return 0;
      }
    }
  } catch (err) {
    if (err instanceof UsageError) {
      stderr(`shortlink: ${err.message}\nRun "shortlink help" for usage.\n`);
      return 2;
    }
    if (err instanceof AppError) {
      stderr(`shortlink: ${err.message}\n`);
      return 1;
    }
    throw err;
  } finally {
    runtime?.close();
  }
}

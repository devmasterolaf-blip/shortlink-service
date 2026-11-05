/**
 * Minimal RFC 4180 CSV reader and writer.
 */

import { ValidationError } from '../errors.js';

/**
 * @param {string} message
 * @param {number} line 1-based line where the problem starts
 */
function csvError(message, line) {
  return new ValidationError(`Invalid CSV at line ${line}: ${message}`, { code: 'csv_invalid', details: { line } });
}

/**
 * Parse CSV text into rows of string cells.
 *
 * Handles quoted cells, doubled quotes inside them, embedded commas and
 * line breaks, CRLF or LF row endings, a leading byte-order mark and a
 * missing final line break. Completely empty lines are skipped.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let cell = '';
  let quoted = false; // inside a quoted cell
  let wasQuoted = false; // the current cell started with a quote
  let line = 1;
  let quoteLine = 1;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const endRow = () => {
    if (row.length > 0 || cell !== '' || wasQuoted) {
      row.push(cell);
      rows.push(row);
    }
    row = [];
    cell = '';
    wasQuoted = false;
  };

  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') line += 1;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (cell !== '' || wasQuoted) throw csvError('unexpected quote inside a cell', line);
      quoted = true;
      wasQuoted = true;
      quoteLine = line;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
      wasQuoted = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
      line += 1;
    } else {
      if (wasQuoted) throw csvError('text after a closing quote', line);
      cell += ch;
    }
  }
  if (quoted) throw csvError('quoted cell is never closed', quoteLine);
  endRow();
  return rows;
}

/**
 * @param {string} cell
 * @returns {string}
 */
function formatCell(cell) {
  return /[",\r\n]/.test(cell) || cell !== cell.trim() ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/**
 * Serialise rows as CSV with CRLF row endings.
 * @param {ReadonlyArray<ReadonlyArray<string>>} rows
 * @returns {string}
 */
export function formatCsv(rows) {
  return rows.map((row) => `${row.map(formatCell).join(',')}\r\n`).join('');
}

/**
 * Parse CSV whose first row names the columns.
 * @param {string} text
 * @returns {{ columns: string[], records: Array<Record<string, string>> }}
 */
export function parseCsvRecords(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw csvError('the header row is missing', 1);
  const columns = header.map((name) => name.trim());
  const duplicate = columns.find((name, index) => columns.indexOf(name) !== index);
  if (duplicate !== undefined) throw csvError(`column "${duplicate}" appears twice`, 1);
  const records = rows.map((row, index) => {
    if (row.length !== columns.length) {
      throw new ValidationError(
        `Invalid CSV: record ${index + 1} has ${row.length} cells, the header has ${columns.length}`,
        { code: 'csv_invalid', details: { record: index + 1 } },
      );
    }
    return Object.fromEntries(columns.map((name, at) => [name, row[at]]));
  });
  return { columns, records };
}

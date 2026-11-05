# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-05

First version.

### Added

- Short codes: base62 codes from a counter passed through a keyed
  permutation, random codes with collision retry, and custom aliases with a
  list of reserved words.
- Destination validation and normalisation: allowed schemes, length limit, no
  credentials, no links back to the service, optional block on loopback,
  private, link-local and reserved hosts.
- Link options: expiry (`expiresAt` or `ttlSeconds`), click budget, scrypt
  password, enabled flag, tags and redirect type.
- Redirect endpoint with 301, 302 and 307 answers, 404 for unknown or
  disabled links, 410 for expired or exhausted ones, password unlock by
  header or form, and cache headers that keep counted links uncached.
- Click statistics per link: totals, per-day clicks and unique visitors with
  a retention window, referrer hosts, user-agent families, keyed visitor
  hashes.
- JSON REST API for links and statistics with pagination, filtering and
  sorting; API keys with scopes; per-key token-bucket rate limit with
  `Retry-After`; request-size limits; one JSON error envelope with request
  ids.
- In-memory store and an append-only JSON-lines file store with compaction
  and recovery from a torn final line.
- Bulk import and export as JSON and CSV, with conflict policies and a dry
  run.
- Configuration from `SHORTLINK_*` environment variables, validated together
  at start-up.
- JSON-lines logging and graceful shutdown on `SIGINT` / `SIGTERM`.
- `shortlink` command line: `create`, `list`, `stats`, `import`, `export`,
  `compact`.

### Known limitations

See the "Limitations" section of the README: one process per data file,
no DNS resolution in the private-host block, no rate limit on redirects or
password attempts, and exports without per-day statistics.

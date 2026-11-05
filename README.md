# shortlink-service

A small self-hosted URL shortener: an HTTP service with a JSON REST API, a
redirect endpoint with click statistics, and an admin command line. It is
written in plain modern JavaScript (ES modules, JSDoc types) for Node.js 22
and has no runtime dependencies; everything is built on `node:http`,
`node:crypto` and `node:fs`.

This is version 0.1.0, a young project. Read [Limitations](#limitations)
before you put it in front of real traffic.

## Features

- Short codes from a counter passed through a keyed permutation (codes do not
  reveal how many links exist), from a random generator with collision retry,
  or from a custom alias.
- Strict destination checks: allowed schemes, maximum length, no credentials
  in the URL, no links back to the service itself, and an optional block on
  loopback, private and other non-public hosts.
- Link options: expiry (`expiresAt` or `ttlSeconds`), a click budget
  (`maxClicks`), a password (stored as a scrypt hash), an enabled flag, tags
  and the redirect type (301, 302 or 307).
- Click statistics per link: totals, clicks and unique visitors per UTC day,
  referrer hosts and user-agent families. Visitors are stored as keyed hashes,
  never as addresses.
- REST API with pagination, filtering and sorting, API keys with scopes
  (compared in constant time), a token-bucket rate limit per key, request-size
  limits and one JSON error format.
- Two stores: in memory, or an append-only JSON-lines file with compaction and
  recovery from a torn last line.
- Bulk import and export as JSON or CSV.
- Graceful shutdown on `SIGINT` / `SIGTERM`.

## Requirements and installation

Node.js 22 or newer. There is nothing to build and nothing to install:

```
git clone <this repository>
cd shortlink-service
npm test
```

## Running the server

All settings come from `SHORTLINK_*` environment variables (see
[Configuration](#configuration)). A typical start with a data file and two
API keys:

```
export SHORTLINK_STORE=file
export SHORTLINK_DATA_FILE=data/links.jsonl
export SHORTLINK_BASE_URL=http://localhost:8080
export SHORTLINK_API_KEYS='admin:change-me-0123456789abcdef:*,reader:read-only-0123456789abcdef:links:read+stats:read'
npm start
```

The server logs one JSON line per event to standard error and listens on
`127.0.0.1:8080` by default. Without `SHORTLINK_API_KEYS` it still starts and
serves redirects, but every API call is answered with 401.

### Create a link

```
curl -s -X POST http://localhost:8080/api/links \
  -H 'Authorization: Bearer change-me-0123456789abcdef' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/a/very/long/path?utm_source=newsletter","alias":"launch","tags":["marketing"],"ttlSeconds":86400}'
```

```json
{
  "code": "launch",
  "shortUrl": "http://localhost:8080/launch",
  "url": "https://example.com/a/very/long/path?utm_source=newsletter",
  "custom": true,
  "createdAt": "2026-11-05T13:53:34.641Z",
  "updatedAt": "2026-11-05T13:53:34.641Z",
  "expiresAt": "2026-11-06T13:53:34.641Z",
  "maxClicks": null,
  "clicks": 0,
  "lastClickAt": null,
  "hasPassword": false,
  "enabled": true,
  "tags": ["marketing"],
  "redirectType": 302,
  "status": "active"
}
```

Leave out `alias` to get a generated code.

### Follow it

```
curl -si http://localhost:8080/launch
```

```
HTTP/1.1 302 Found
Location: https://example.com/a/very/long/path?utm_source=newsletter
Cache-Control: no-store
Referrer-Policy: no-referrer
```

### List, inspect, change, delete

```
curl -s 'http://localhost:8080/api/links?tag=marketing&sort=-clicks&pageSize=5' \
  -H 'Authorization: Bearer change-me-0123456789abcdef'

curl -s http://localhost:8080/api/links/launch/stats \
  -H 'Authorization: Bearer change-me-0123456789abcdef'

curl -s -X PATCH http://localhost:8080/api/links/launch \
  -H 'Authorization: Bearer change-me-0123456789abcdef' \
  -H 'Content-Type: application/json' \
  -d '{"password":"s3cret-word","maxClicks":100}'

curl -s -X DELETE http://localhost:8080/api/links/launch \
  -H 'Authorization: Bearer change-me-0123456789abcdef'
```

## HTTP API

Every `/api` route needs an API key, sent as `Authorization: Bearer <key>` or
`X-API-Key: <key>`.

| Method and path | Scope | Result |
| --- | --- | --- |
| `GET /healthz` | none | `{"status":"ok","links":2,"uptimeSeconds":17}` |
| `POST /api/links` | `links:write` | 201, the new link, `Location` header |
| `GET /api/links` | `links:read` | a page of links |
| `GET /api/links/:code` | `links:read` | one link |
| `PATCH /api/links/:code` | `links:write` | the changed link |
| `DELETE /api/links/:code` | `links:write` | 204 |
| `GET /api/links/:code/stats` | `stats:read` | click statistics |
| `GET /api/export?format=json\|csv` | `admin` | all links as a download |
| `POST /api/import?onConflict=...&dryRun=...` | `admin` | an import summary |

### Link fields

Accepted by `POST /api/links`; `PATCH` accepts the same fields except `alias`.
Unknown fields are rejected.

| Field | Meaning |
| --- | --- |
| `url` | Destination, required on create. Normalised before it is stored. |
| `alias` | Custom code: 3 to 32 letters, digits, `-` or `_`, starting and ending with a letter or digit. Words that would shadow routes (`api`, `healthz`, `admin`, ...) are reserved. Aliases are case-sensitive. |
| `expiresAt` | Epoch milliseconds or an ISO-8601 time with a time zone; must be in the future. `null` removes the expiry. |
| `ttlSeconds` | Alternative to `expiresAt`: seconds from now. |
| `maxClicks` | Click budget, 1 to 1,000,000,000, or `null` for unlimited. |
| `password` | 4 to 128 characters, or `null` for none. Only a scrypt hash is stored; responses carry `hasPassword`. |
| `enabled` | `false` makes the link answer 404 without deleting it. |
| `tags` | Up to 10 tags of 1 to 32 characters (`a-z`, `0-9`, `-`, `_`); lower-cased and de-duplicated. |
| `redirectType` | 301, 302 or 307. The default comes from `SHORTLINK_DEFAULT_REDIRECT`. |

A link's `status` is `active`, `disabled`, `expired` or `exhausted`.

### Listing

`GET /api/links` takes these query parameters; unknown ones are rejected.

| Parameter | Meaning |
| --- | --- |
| `page`, `pageSize` | 1-based page and page size (default 20, maximum 100) |
| `sort` | `createdAt`, `updatedAt`, `clicks`, `code`, `expiresAt` or `lastClickAt`; prefix with `-` for descending. Default `-createdAt`. |
| `tag` | A tag the link must carry; separate several with commas to require all of them |
| `enabled` | `true` or `false` |
| `status` | `active`, `disabled`, `expired` or `exhausted` |
| `q` | Case-insensitive substring of the code or the URL |
| `createdAfter`, `createdBefore` | Inclusive lower and exclusive upper bound on the creation time |

The answer is `{"items":[...],"page":1,"pageSize":20,"total":42,"totalPages":3}`.

### Statistics

`GET /api/links/:code/stats` accepts optional `from` and `to` days
(`YYYY-MM-DD`, UTC, inclusive):

```json
{
  "code": "launch",
  "totalClicks": 1,
  "clicksInRange": 1,
  "uniqueVisitors": 1,
  "lastClickAt": "2026-11-05T13:53:34.664Z",
  "days": [{ "date": "2026-11-05", "clicks": 1, "uniqueVisitors": 1 }],
  "referrers": [{ "referrer": "(direct)", "clicks": 1 }],
  "userAgents": [{ "family": "curl", "clicks": 1 }]
}
```

Per-day figures are kept for `SHORTLINK_STATS_RETENTION_DAYS` days; the total
is kept for the life of the link.

### Errors

Every error has the same shape and carries the request id that is also sent
in the `X-Request-Id` response header:

```json
{
  "error": {
    "code": "url_scheme_not_allowed",
    "message": "url scheme \"javascript\" is not allowed (allowed: http, https)",
    "details": { "field": "url" },
    "requestId": "8a579a04-56ec-4aae-9de8-d2fdf95ae304"
  }
}
```

Statuses in use: 400 (validation), 401 (missing or wrong API key, or a link
password is needed), 403 (missing scope, wrong link password), 404, 405, 409
(alias taken), 410, 413 (body too large), 415 (wrong content type), 429 (rate
limit, with `Retry-After`) and 500. Internal error details are logged, not
sent to the client.

### Rate limiting

Each API key has a token bucket of `SHORTLINK_RATE_LIMIT_CAPACITY` requests,
refilled at `SHORTLINK_RATE_LIMIT_REFILL_PER_SEC`. Responses carry
`X-RateLimit-Limit` and `X-RateLimit-Remaining`; a rejected request gets 429
and `Retry-After` in seconds. The limit applies to authenticated API calls
only.

## Redirects

`GET /:code` (and `HEAD`, which is not counted as a click):

| Situation | Answer |
| --- | --- |
| Active link | 301, 302 or 307 with `Location` |
| Unknown or disabled link | 404 |
| Expired link, or click budget used up | 410 |
| Password-protected link, no password sent | 401 `password_required` |
| Wrong password | 403 `password_incorrect` |

The password travels in the `X-Link-Password` request header, or in a `POST`
to the same path with a JSON body `{"password":"..."}` or a form field
`password=...`; a successful `POST` answers 303.

Only an unconditional permanent redirect may be cached: a 301 link without a
password and without a click budget is served with
`Cache-Control: public, max-age=<SHORTLINK_PERMANENT_MAX_AGE>` (or `private`
with the remaining lifetime when it has an expiry). Everything else is
`no-store`, so each visit reaches the service and is counted.

## Import and export

```
curl -s 'http://localhost:8080/api/export?format=csv' \
  -H 'Authorization: Bearer change-me-0123456789abcdef' -o links.csv

curl -s -X POST 'http://localhost:8080/api/import?onConflict=skip&dryRun=true' \
  -H 'Authorization: Bearer change-me-0123456789abcdef' \
  -H 'Content-Type: text/csv' --data-binary @links.csv
```

The JSON form is `{"version":1,"exportedAt":"...","links":[...]}`; the CSV
form has one row per link with the columns `code, url, custom, createdAt,
updatedAt, expiresAt, maxClicks, clicks, lastClickAt, enabled, tags,
redirectType, passwordHash` (tags joined with `|`). Both carry the password
hash, never a password, so treat export files as sensitive.

On import each record is validated on its own. `onConflict` decides what
happens when a code already exists: `skip` (default), `error` (count it as
failed) or `overwrite`. `dryRun=true` validates and reports without writing.
The answer lists what happened:

```json
{ "total": 2, "created": 0, "overwritten": 0, "skipped": 2, "failed": 0, "dryRun": true, "errors": [] }
```

Per-day click statistics are not part of an export.

## Command line

`bin/shortlink.js` works on the data file directly, without the server, and
reads the same environment variables. It needs the file store
(`--data-file <path>` or `SHORTLINK_STORE=file`).

```
$ node bin/shortlink.js create https://example.com/from-cli --alias cli-made --tag ops --data-file data/links.jsonl
http://localhost:8080/cli-made

$ node bin/shortlink.js list --data-file data/links.jsonl
CODE      STATUS  CLICKS  EXPIRES  URL
cli-made  active  0       -        https://example.com/from-cli

page 1 of 1, 1 link(s)
```

```
shortlink create <url>   --alias --ttl --expires --max-clicks --password --tag --redirect --disabled
shortlink list           --tag --status --q --sort --page --page-size
shortlink stats <code>   --from --to
shortlink import <file>  --format json|csv --dry-run --on-conflict skip|error|overwrite
shortlink export         --format json|csv --output <file>
shortlink compact
```

`--json` prints machine-readable output for `create`, `list`, `stats` and
`import`. Exit codes: 0 success, 1 failure, 2 usage error.

Do not run the command line against a data file while a server has it open;
see [Limitations](#limitations).

## Configuration

Invalid values and unknown `SHORTLINK_*` names are all reported together at
start-up, and the process exits with status 1.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHORTLINK_PORT` | `8080` | Listening port; `0` picks a free one |
| `SHORTLINK_HOST` | `127.0.0.1` | Listening address |
| `SHORTLINK_BASE_URL` | `http://localhost:<port>` | Public origin used in `shortUrl`; a bare origin without a path |
| `SHORTLINK_STORE` | `memory` | `memory` or `file` |
| `SHORTLINK_DATA_FILE` | `data/links.jsonl` | Journal file of the file store |
| `SHORTLINK_FSYNC` | `always` | `always` flushes every record to the device; `never` leaves it to the operating system |
| `SHORTLINK_CODE_STRATEGY` | `counter` | `counter` or `random` |
| `SHORTLINK_CODE_LENGTH` | `5` (counter), `7` (random) | Length of generated codes, 4 to 12 |
| `SHORTLINK_CODE_SECRET` | none | Key of the counter permutation; set it so codes cannot be predicted from the source code |
| `SHORTLINK_API_KEYS` | none | Comma-separated `name:secret:scopes` entries |
| `SHORTLINK_RATE_LIMIT_CAPACITY` | `60` | Burst size per API key |
| `SHORTLINK_RATE_LIMIT_REFILL_PER_SEC` | `1` | Tokens added per second |
| `SHORTLINK_MAX_BODY_BYTES` | `16384` | Limit for JSON API bodies |
| `SHORTLINK_MAX_IMPORT_BYTES` | `5242880` | Limit for import documents |
| `SHORTLINK_MAX_URL_LENGTH` | `2048` | Longest accepted destination |
| `SHORTLINK_ALLOWED_SCHEMES` | `http,https` | Accepted destination schemes |
| `SHORTLINK_BLOCK_PRIVATE_HOSTS` | `false` | Reject loopback, private, link-local and reserved hosts |
| `SHORTLINK_DEFAULT_REDIRECT` | `302` | Redirect type of new links |
| `SHORTLINK_PERMANENT_MAX_AGE` | `86400` | `max-age` of cacheable 301 answers, in seconds |
| `SHORTLINK_TRUST_PROXY` | `false` | Take the client address from `X-Forwarded-For` |
| `SHORTLINK_VISITOR_SECRET` | random per process | Key for visitor hashes, at least 16 characters |
| `SHORTLINK_STATS_RETENTION_DAYS` | `90` | Days of per-day statistics kept per link |
| `SHORTLINK_SHUTDOWN_GRACE_MS` | `10000` | Time given to open requests on shutdown |
| `SHORTLINK_LOG_LEVEL` | `info` | `info`, `error` or `silent` |

### API keys

An entry is `name:secret:scopes`. The secret needs at least 16 characters and
cannot contain `:` or `,`. Scopes are joined with `+` and are `links:read`,
`links:write`, `stats:read` and `admin`; `*` grants all of them. `admin` only
covers import and export, it does not include the other scopes.

## Storage

The file store is a journal: every change is appended as one JSON object per
line and applied to the in-memory state afterwards, so memory never runs
ahead of the file.

```
{"op":"seq","value":1}
{"op":"put","link":{"code":"6cEnv","url":"https://example.com/docs", ...}}
{"op":"click","code":"6cEnv","at":1793886814664,"referrer":"(direct)","userAgent":"curl","visitor":"7759f8a134f27dfe"}
{"op":"del","code":"6cEnv"}
```

Opening a store replays the file. A final line that was cut off by a crash is
removed (the change it described was never acknowledged); a damaged line
anywhere else stops the start-up with an error that names the line.
Compaction (`shortlink compact`, and automatically at start-up once the
journal is much larger than its content) writes a snapshot to
`<file>.tmp`, flushes it and renames it over the journal. The data file is
created with mode `0600`.

## Using it as a library

```js
import { loadConfig, start } from './src/index.js';

const config = loadConfig({
  SHORTLINK_PORT: '0',
  SHORTLINK_BASE_URL: 'https://sho.rt',
  SHORTLINK_LOG_LEVEL: 'silent',
});
const server = await start(config);
const link = await server.runtime.service.createLink({ url: 'https://example.com/' });
console.log(server.port, link.shortUrl); // e.g. 43815 https://sho.rt/6cEnv
await server.close();
```

## Project layout

```
bin/shortlink.js        command-line entry point
src/main.js             server entry point (npm start)
src/serve.js            start, stop and signal handling
src/runtime.js          builds the store and the service from the configuration
src/config.js           SHORTLINK_* environment variables
src/errors.js           typed errors with HTTP statuses and codes
src/clock.js            system clock and a manual clock for tests
src/codes/              base62, keyed permutation, generators, alias rules
src/url/                destination validation and normalisation
src/security/           scrypt passwords, API keys, token-bucket limiter
src/analytics/          click statistics, referrer and user-agent classes, visitor hashes
src/storage/            memory store and journal file store
src/service/            link rules: input parsing, status, listing, statistics reports
src/http/               router, request context, body reading, middleware, routes
src/io/                 CSV and import/export
src/cli/                the shortlink command
test/                   node:test suites
```

Dependencies point one way: `http` and `cli` call `service`, `service` calls
`storage`, and nothing below knows about HTTP.

## Tests

```
npm test
```

The suite uses the built-in `node:test` runner. HTTP tests start the server
on an ephemeral port inside the test process and close it again. Tests that
need files work in `.scratch/` inside the repository (git-ignored); set
`SHORTLINK_TEST_TMPDIR` to use another directory. Time-dependent behaviour is
tested with a manual clock.

## Limitations

- One process per data file. There is no file lock, so a second process (for
  example the command line while the server runs) can overwrite codes
  allocated by the first.
- The private-host block looks at the host as written. It does not resolve
  DNS names, so a public name that points at a private address passes.
- Redirects, link-password attempts and failed API-key attempts are not rate
  limited.
- Listing sorts all links on every request, and the whole journal is read
  into memory at start-up. This is fine for tens of thousands of links, not
  for millions.
- Exports do not include per-day statistics, and an import is not atomic:
  records before a failing one stay imported.
- Expired links are kept until they are deleted.
- No TLS and no HTML pages: put a reverse proxy in front, and expect JSON
  answers for password-protected links.

## License

MIT, see [LICENSE](LICENSE).

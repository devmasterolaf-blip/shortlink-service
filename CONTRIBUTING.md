# Contributing

Thanks for taking the time to look at this project. It is small on purpose;
changes that keep it small and dependency-free are the easiest to accept.

## Setup

You need Node.js 22 or newer and nothing else. There are no dependencies to
install.

```
npm test
```

runs the whole suite with the built-in `node:test` runner. To run one file:

```
node --test test/linkService.test.js
```

A coverage summary is available from Node itself:

```
node --test --experimental-test-coverage "test/**/*.test.js"
```

## Ground rules

- No runtime dependencies. Use the Node standard library.
- Plain JavaScript with ES modules. Describe types with JSDoc and document
  every exported function.
- Keep the layers apart: `src/http` and `src/cli` call `src/service`,
  `src/service` calls `src/storage`. Code below the HTTP layer must not know
  about requests or responses.
- State changes go through a journal record in `MemoryStore` (`_commit`), so
  the file store persists them without extra code. Do not mutate the maps
  directly.
- Fail with one of the typed errors from `src/errors.js`. Give validation
  errors a stable `code` and, where it applies, the offending `field`; the
  HTTP layer turns them into the JSON error envelope.
- Take the time from the injected clock (`src/clock.js`), never from
  `Date.now()` directly, so behaviour stays testable.

## Tests

- Every change in behaviour needs a test; a bug fix needs a test that fails
  without the fix.
- HTTP tests start the server on port 0 inside the test process and close it
  in `t.after` (see `test/httpHelpers.js`). Never bind a fixed port and never
  leave a server running.
- Use `ManualClock` instead of sleeping.
- Tests that need files call `tempDir(t)` from `test/tmp.js`, which works in
  `.scratch/` (git-ignored) and cleans up afterwards.
- Password tests pass a low scrypt cost (`FAST_COST` in `test/helpers.js`) to
  stay fast.

## Commits and pull requests

- One logical change per commit, with a message in the form
  `type(scope): summary` (`feat`, `fix`, `test`, `docs`, `refactor`, `perf`).
- Run `npm test` before you commit.
- Update `README.md` when behaviour, configuration or the API changes, and
  add a line to `CHANGELOG.md` under "Unreleased".
- Do not commit data files, logs or secrets. API keys in examples and tests
  are placeholders.

## Reporting problems

Open an issue with the version (`shortlink --version`), the Node.js version,
the relevant `SHORTLINK_*` settings (without secrets), and the request and
response that show the problem. The `requestId` from an error answer helps to
find the matching log line.

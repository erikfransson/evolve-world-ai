# Idea 76: retry a failed periodic save, longer pack budget on stop

| Idea | Before | After | Exact? | Lines (src / test) | Verdict |
|------|--------|-------|--------|--------------------|---------|
| Periodic save retries after a transient worker failure (15, 30, 60 min, last repeats, reset on success); stop path packs up to 25 s | one pack timeout (10 s) leaves the world unsaved for 4 h; a stop under load loses up to 4 h | retry in 15 min; stop save has 25 s to pack | Not a tick change (server durability only) | about 70 / 150 | Merge (server code: 3-review push gate) |

Not a speed idea: no bench. Measured by tests only: `npx vitest run liveSaves live --testTimeout=180000 --maxWorkers=1` (18 files, 303 tests, exit 0) and `tsc --noEmit` in `server/` (exit 0), both at idle priority on cores 2,3,6,7.

## Retry (`Saves.periodic`, `main.ts` interval)
- `saveParse.ts` throws `WorkerFailed` for a worker timeout, error (out of memory) or exit, in both the packer and the verify parser. A save a worker judged bad, `TooBig`, a disk-cap refusal, failing ticks and a reset in progress stay plain errors and are not retried.
- On `WorkerFailed` the periodic save schedules one `setTimeout` (unref'd) after `LIMITS.saveRetryMs[min(n, 2)]` = 15, 30, 60 min, and logs `save retry n in X min`. State: one timer, one counter, one stop flag. A success of any save (periodic, retry or admin save-now) cancels the timer and resets the counter; the 4 h tick replaces a pending timer.
- Retries go through `save()` and the existing `exclusive` queue: at most one save in flight. `PACK_TIMEOUT_MS` (10 s) and `VERIFY_TIMEOUT_MS` (40 s) are unchanged for the periodic path.
- The stop path calls `stopRetries()` first: no timer, `periodic()` becomes a no-op.

## Stop path (coordinator addition)
- `save(true)` from `stop()`: when no other save was queued or running at the stop, the pack timeout is `STOP_PACK_MS` = 25 s, else the normal 10 s.
- Verify timeout is `min(40 s, 50 s - time since the stop was asked)`, at least 5 s. Worst case: 25 s pack + 25 s verify = 50 s, plus write and exit inside the unit's 60 s. A fast pack leaves the full 40 s verify.
- Chosen over a CPU-time deadline: simpler, no worker protocol change, still wall-bounded.

## Tests (`tests/typescript/liveSaveRetry.test.ts`, fake `setTimeout`, mocked `packSave` script)
Retry after 15 / 30 / 60 / 60 min, not before; success resets the backoff; TooBig, disk cap and a plain error are not retried; verify `WorkerFailed` retried, plain verify error not; retry that falls due during a manual save waits (max one in flight) and a periodic tick replaces the timer; manual success cancels the retry; `stopRetries` schedules none; stop pack 25 s alone, 10 s behind another save; verify budget bounds; a timed-out stop pack writes nothing.

## Stop behind another save (idea 77, from the re-check review)
A stop asked while another save is packing used to wait for it (pack 10 s, verify up to 40 s, write) and then run its own save with a 10 s pack and the 5 s verify floor: about 65 s plus two writes, so systemd's `TimeoutStopSec=60` could SIGKILL it mid-save. Now `saveNow` for a stop that was not alone first checks `Saves.lastSavedAt` (set after each successful write): a save that went through after `stop.at` makes the stop return "already saved ..." without a second save. Otherwise, if less than `PACK_TIMEOUT_MS` + `STOP_VERIFY_MIN_MS` (15 s) of `STOP_BUDGET_MS` is left since `stop.at`, it throws "the stop budget is spent, the last good save is kept" without starting a worker (`main.ts` logs it and shuts down). Tests: the in-flight save succeeds (stop skipped), the in-flight save fails with budget left (stop saves with the 10 s pack), and the budget is spent (throws, one worker call in total).

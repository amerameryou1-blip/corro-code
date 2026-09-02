# Optimistic Submissions

The client uses two internal, dependency-free modules for local submissions.
Neither imports Solid, Effect, QUARK, or the HTTP client. These are not a new
query cache or a separately published library.

- `Command` owns captured input, ordered execution, retry attempts, and external confirmation.
- `Optimistic` owns local contributions and composes them with authoritative collections.
- `solid/data.ts` translates server events, chooses retry policy, and bridges changes into Solid.

## Commands

```ts
const queue = Command.queue()
const send = Command.make({
  key: (input: PromptInput) => input.id,
  group: (input) => input.sessionID,
  queue,
  execute:
    (input) =>
    async ({ signal }) =>
      api.session.prompt(input, { signal }),
  retry: {
    delays: [250, 750, 1500],
    when: isRetryableAdmissionFailure,
  },
})

const operation = send.submit(input, { wait: sessionCreation })
await operation.request
```

Input is cloned once at submission. Reusing a key in the same group returns the
existing operation and ignores the new payload; cross-group reuse fails. A
manual `operation.retry()` joins active work or restarts a failed operation with
the original input. It does not create a new remote identity.

Commands sharing a queue serialize within each group. Different groups execute
independently. In OpenCode, prompts and compactions share the session's admission
queue. Cancelling an item waiting behind another item cannot let its successors
bypass the earlier item.

`execute(input)` is a per-cycle factory: it runs once initially and once for
each explicit manual retry. Its returned function runs for each automatic
attempt. This lets model selection succeed once during an automatic retry
cycle, while a manual retry reapplies the captured model after intervening user
changes. The separate `prepare` submission option runs at most once and is never
automatically retried.

## Confirmation Is Not HTTP Settlement

| Observation                                | Command State                  | Local Contribution                  |
| ------------------------------------------ | ------------------------------ | ----------------------------------- |
| Request starts                             | `sending`                      | Visible                             |
| Transient failure with attempts remaining  | `retrying`                     | Visible                             |
| Attempts exhausted                         | `failed`                       | Retained for explicit retry/cancel  |
| HTTP returns canonical payload             | `accepted`                     | Retained until projected            |
| Canonical event or positive read           | Accepted and retired           | Removed after canonical publication |
| Definitive rejection or local cancellation | Rejected/cancelled and retired | Removed                             |

```ts
// Publish the canonical item before retiring its local contribution.
batch(() => {
  publishCanonical(item)
  send.confirm(item.id, item)
})
```

Confirmation resolves active waiters and interrupts outstanding local work.
A subsequent HTTP rejection cannot overturn it. A caller already holding a
settled failed Promise still has that failure; the operation's current request
can expose later canonical confirmation.

Delivery events may prove acceptance without carrying the canonical payload.
`confirmFrom(key, load)` records this positive proof and obtains the actual
payload. A failed lookup cannot turn a proven admission into a definitive
rollback, and a later observation can retry the lookup. OpenCode additionally
reloads ordered history rather than appending a late message lookup behind its
assistant response.

## Views, Not Rollbacks

```ts
const local = Optimistic.make<InboxItem>({
  key: (item) => item.id,
  group: (item) => item.sessionID,
})

local.set(preview)
const visible = Optimistic.merge(serverItems, local.list(sessionID), (item) => item.id)
```

Canonical items win by ID. The merge preserves their order and object references,
then appends unmatched local contributions in submission order. When there are
no unmatched local contributions, it returns the canonical array itself.

Observation must retire local contributions explicitly. Merely hiding a local
row behind a matching canonical ID would allow it to reappear after cache
eviction. Conversely, absence from an inbox or history snapshot is not evidence
that a local submission failed.

The Solid adapter maintains per-session local preview arrays independently of
submission status. Retrying does not rebuild the transcript, and canonical
assistant/tool/text proxies keep their existing fine-grained subscriptions.
Local prompt and compaction contributions share the same overlay so their
relative submission order is preserved.

## Ownership

Client ownership, not component observation, controls operation lifetime.
Unsubscribing does not cancel work. Ordinary session cache eviction preserves
unconfirmed contributions. Session deletion and client disposal cancel them.

`cancel` only stops local work. OpenCode separately calls the server's inbox
cancellation endpoint when admission may have been attempted. Neither aborting a
fetch nor disposing a client proves that a remote write was undone.

This module does not establish the cause of the original lost-submission report.
Same-ID retries and retained local state are mitigations, not incident resolution.

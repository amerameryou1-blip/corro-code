import { describe, expect, test } from "bun:test"
import { Command } from "../src/command"

describe("Command.queue", () => {
  test("captures wait at enqueue, serializes each group, and releases successors after failure", async () => {
    const queue = Command.queue()
    const gate = Promise.withResolvers<void>()
    const calls: string[] = []
    const failure = new Error("creation failed")
    const first = queue.run("one", async () => calls.push("first"), { wait: gate.promise })
    const second = queue.run("one", async () => calls.push("second"))
    const other = queue.run("two", async () => calls.push("other"))
    expect(queue.pending("one")).toBe(true)
    await other
    expect(calls).toEqual(["other"])
    gate.reject(failure)
    await expect(first).rejects.toBe(failure)
    await second
    expect(calls).toEqual(["other", "second"])
    await wait(() => !queue.pending("one"))
  })

  test("an aborted gated item settles promptly without bypassing its predecessor", async () => {
    const queue = Command.queue()
    const predecessor = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const abort = new AbortController()
    const calls: string[] = []
    const first = queue.run("one", async () => {
      calls.push("first")
      await predecessor.promise
    })
    const middle = queue.run("one", async () => calls.push("middle"), { wait: gate.promise, signal: abort.signal })
    const last = queue.run("one", async () => calls.push("last"))
    await wait(() => calls.length === 1)
    abort.abort(new Error("cancelled gate"))
    await expect(middle).rejects.toBe(abort.signal.reason)
    await Bun.sleep(1)
    expect(calls).toEqual(["first"])
    predecessor.resolve()
    await Promise.all([first, last])
    expect(calls).toEqual(["first", "last"])
    gate.reject(new Error("late gate failure"))
  })

  test("does not invoke an already aborted item", async () => {
    const queue = Command.queue()
    const abort = new AbortController()
    abort.abort()
    let called = false
    await expect(queue.run("one", async () => (called = true), { signal: abort.signal })).rejects.toBe(
      abort.signal.reason,
    )
    expect(called).toBe(false)
  })
})

type Input = { id: string; session: string; payload: { text: string }; model?: { id: string } }

function input(id = "message", session = "session"): Input {
  return { id, session, payload: { text: "original" }, model: { id: "demo" } }
}

function setup(
  execute: (input: Input) => (context: Command.Context) => Promise<string>,
  options?: { queue?: Command.Queue; retry?: { delays: readonly number[]; when: (error: unknown) => boolean } },
) {
  return Command.make({
    key: (input: Input) => input.id,
    group: (input: Input) => input.session,
    queue: options?.queue ?? Command.queue(),
    execute,
    retry: options?.retry,
  })
}

describe("Command.make", () => {
  test("captures one payload and key; duplicate submissions preserve the first operation", async () => {
    const gate = Promise.withResolvers<void>()
    const seen: Input[] = []
    const manager = setup((value) => async () => {
      seen.push(value)
      return value.payload.text
    })
    const value = input()
    const operation = manager.submit(value, { wait: gate.promise })
    value.payload.text = "changed"
    value.model!.id = "changed"
    expect(operation.input).toEqual(input())
    expect(operation.input).not.toBe(value)
    expect(operation.started).toBe(false)
    expect(operation.createdAt).toBeGreaterThan(0)
    expect(manager.submit(value)).toBe(operation)
    expect(() => manager.submit(input(value.id, "other"))).toThrow("belongs to another group")
    expect(manager.get(value.id)).toBe(operation)
    expect(manager.values()).toEqual([operation])
    gate.resolve()
    await expect(operation.request).resolves.toBe("original")
    expect(seen).toEqual([input()])
    expect(seen[0]).toBe(operation.input)
    expect(operation.started).toBe(true)
    manager.dispose()
  })

  test("shares FIFO between managers while other sessions execute independently", async () => {
    const queue = Command.queue()
    const first = Promise.withResolvers<string>()
    const calls: string[] = []
    const prompts = setup(
      (value) => async () => {
        calls.push(value.id)
        return first.promise
      },
      { queue },
    )
    const controls = setup(
      (value) => async () => {
        calls.push(value.id)
        return value.id
      },
      { queue },
    )
    const prompt = prompts.submit(input("prompt"))
    const compact = controls.submit(input("compact"))
    const other = controls.submit(input("other", "other"))
    await other.request
    expect(calls).toEqual(["prompt", "other"])
    first.resolve("prompt")
    await Promise.all([prompt.request, compact.request])
    expect(calls).toEqual(["prompt", "other", "compact"])
    prompts.dispose()
    controls.dispose()
  })

  test("retries captured data, prepares once, and rebuilds per-cycle factory state only on manual retry", async () => {
    const seen: Input[] = []
    const attempts: number[] = []
    let prepared = 0
    let factories = 0
    let selections = 0
    let succeed = false
    const failure = new Error("offline")
    const manager = setup(
      (value) => {
        factories++
        let selected = false
        return async (context) => {
          seen.push(value)
          attempts.push(context.attempt)
          if (!selected) {
            selections++
            selected = true
            context.stage("model")
          }
          context.stage("prompt")
          if (!succeed) throw failure
          return "accepted"
        }
      },
      { retry: { delays: [1, 1], when: (error) => error === failure } },
    )
    const operation = manager.submit(input(), {
      prepare: async () => {
        prepared++
      },
    })
    expect(operation.retry()).toBe(operation.request)
    const original = operation.request
    await expect(original).rejects.toMatchObject({ reason: "failed", key: "message", cause: failure })
    expect(operation.state).toMatchObject({ status: "failed", attempt: 3, stage: "prompt" })
    expect(manager.get(operation.key)).toBe(operation)
    expect(prepared).toBe(1)
    expect(factories).toBe(1)
    expect(selections).toBe(1)
    succeed = true
    const retried = operation.retry()
    expect(retried).not.toBe(original)
    expect(operation.request).toBe(retried)
    expect(operation.retry()).toBe(retried)
    await expect(retried).resolves.toBe("accepted")
    expect(attempts).toEqual([1, 2, 3, 1])
    expect(seen.every((value) => value === operation.input)).toBe(true)
    expect(prepared).toBe(1)
    expect(factories).toBe(2)
    expect(selections).toBe(2)
    manager.dispose()
  })

  test("preparation and gate failures are definitive and never retried", async () => {
    for (const stage of ["prepare", "waiting"]) {
      const failure = new Error(stage)
      let factories = 0
      let classified = 0
      const manager = setup(
        () => {
          factories++
          return async () => "unexpected"
        },
        {
          retry: {
            delays: [1],
            when: () => {
              classified++
              return true
            },
          },
        },
      )
      const operation = manager.submit(input(), {
        wait: stage === "waiting" ? Promise.reject(failure) : undefined,
        prepare: async () => {
          throw failure
        },
      })
      await expect(operation.request).rejects.toBe(failure)
      expect(operation.state).toMatchObject({ status: "rejected", stage, attempt: 0, error: failure })
      expect(operation.started).toBe(false)
      expect(factories).toBe(0)
      expect(classified).toBe(0)
      expect(manager.values()).toEqual([])
    }
  })

  test("definitive execution rejection preserves the original error and removes the operation", async () => {
    const failure = new Error("invalid")
    const manager = setup(() => async () => {
      throw failure
    })
    const operation = manager.submit(input())
    await expect(operation.request).rejects.toBe(failure)
    expect(operation.state).toMatchObject({ status: "rejected", attempt: 1, error: failure })
    expect(manager.values()).toEqual([])
    operation.confirm("too late")
    expect(operation.accepted).toBeUndefined()
    await expect(operation.retry()).rejects.toBe(failure)
  })

  test("HTTP acceptance is retained until canonical confirmation, with deterministic removal events", async () => {
    const manager = setup(() => async () => "http")
    const events: { status: string; removed: boolean; retained: boolean }[] = []
    manager.subscribe(({ operation, removed }) => {
      events.push({ status: operation.state.status, removed, retained: !!manager.get(operation.key) })
    })
    const operation = manager.submit(input())
    await expect(operation.request).resolves.toBe("http")
    expect(operation.accepted).toBe("http")
    expect(operation.signal.aborted).toBe(false)
    expect(manager.values()).toEqual([operation])
    expect(events.at(-1)).toEqual({ status: "accepted", removed: false, retained: true })
    manager.confirm(operation.key, "canonical")
    expect(operation.accepted).toBe("canonical")
    expect(operation.signal.aborted).toBe(true)
    expect(manager.values()).toEqual([])
    expect(events.slice(-2)).toEqual([
      { status: "accepted", removed: false, retained: false },
      { status: "accepted", removed: true, retained: false },
    ])
    operation.cancel()
    await expect(operation.retry()).resolves.toBe("canonical")
  })

  test("confirmation settles behind a gate without executing or releasing an earlier owner", async () => {
    const queue = Command.queue()
    const predecessor = Promise.withResolvers<void>()
    const owner = queue.run("session", () => predecessor.promise)
    let executed = 0
    const manager = setup(
      () => async () => {
        executed++
        return "http"
      },
      { queue },
    )
    const operation = manager.submit(input(), { wait: new Promise(() => {}) })
    let followed = false
    const follower = queue.run("session", async () => {
      followed = true
    })
    manager.confirm(operation.key, "canonical")
    await expect(operation.request).resolves.toBe("canonical")
    await Bun.sleep(1)
    expect(followed).toBe(false)
    expect(executed).toBe(0)
    expect(operation.started).toBe(false)
    predecessor.resolve()
    await Promise.all([owner, follower])
    expect(followed).toBe(true)
  })

  test("cancelling preparation settles immediately and ignores its eventual result", async () => {
    const preparation = Promise.withResolvers<void>()
    const preparing = Promise.withResolvers<void>()
    let factories = 0
    const manager = setup(() => {
      factories++
      return async () => "http"
    })
    const operation = manager.submit(input(), {
      prepare: async () => {
        preparing.resolve()
        return preparation.promise
      },
    })
    await preparing.promise
    manager.cancel(operation.key)
    await expect(operation.request).rejects.toMatchObject({ reason: "cancelled" })
    preparation.reject(new Error("late prepare"))
    await Bun.sleep(1)
    expect(factories).toBe(0)
    expect(operation.started).toBe(false)
    expect(manager.values()).toEqual([])
  })

  test("confirmation at the prepare boundary prevents preparation and execution from starting", async () => {
    let prepared = false
    const manager = setup(() => async () => "unexpected")
    manager.subscribe(({ operation }) => {
      if (operation.state.status === "sending" && operation.state.stage === "prepare") operation.confirm("canonical")
    })
    const operation = manager.submit(input(), {
      prepare: async () => {
        prepared = true
      },
    })
    await expect(operation.request).resolves.toBe("canonical")
    await Bun.sleep(1)
    expect(prepared).toBe(false)
    expect(operation.started).toBe(false)
    expect(operation.state.status).toBe("accepted")
  })

  test("supports undefined canonical output without confusing it with an unconfirmed operation", async () => {
    const manager = Command.make<string, void>({
      key: (input) => input,
      group: () => "session",
      queue: Command.queue(),
      execute: () => async () => {
        throw new Error("must not execute")
      },
    })
    const operation = manager.submit("void", { wait: new Promise(() => {}) })
    operation.confirm(undefined)
    await expect(operation.request).resolves.toBeUndefined()
    await expect(operation.retry()).resolves.toBeUndefined()
    expect(operation.state.status).toBe("accepted")
    expect(manager.values()).toEqual([])
  })

  test("confirmation cancels backoff promptly and can recover an exhausted operation", async () => {
    for (const phase of ["retrying", "failed"]) {
      const failure = new Error("offline")
      let calls = 0
      const manager = setup(
        () => async () => {
          calls++
          throw failure
        },
        {
          retry: { delays: phase === "retrying" ? [60_000] : [], when: () => true },
        },
      )
      const reached = Promise.withResolvers<void>()
      manager.subscribe(({ operation }) => {
        if (operation.state.status === phase) reached.resolve()
      })
      const operation = manager.submit(input())
      const first = operation.request
      await reached.promise
      manager.confirm(operation.key, "canonical")
      await expect(operation.request).resolves.toBe("canonical")
      if (phase === "failed") await expect(first).rejects.toBeInstanceOf(Command.Error)
      else await expect(first).resolves.toBe("canonical")
      expect(operation.state.status).toBe("accepted")
      expect(calls).toBe(1)
      expect(manager.values()).toEqual([])
    }
  })

  test.each(["resolve", "reject"])(
    "late HTTP %s and stage reports cannot resurrect confirmed or cancelled handles",
    async (outcome) => {
      for (const action of ["confirm", "cancel"]) {
        const response = Promise.withResolvers<string>()
        const invoked = Promise.withResolvers<Command.Context>()
        const manager = setup(() => async (context) => {
          invoked.resolve(context)
          return response.promise
        })
        const events: string[] = []
        manager.subscribe(({ operation, removed }) => events.push(`${operation.state.status}:${removed}`))
        const operation = manager.submit(input())
        const context = await invoked.promise
        if (action === "confirm") operation.confirm("canonical")
        else operation.cancel()
        if (action === "confirm") await expect(operation.request).resolves.toBe("canonical")
        else await expect(operation.request).rejects.toMatchObject({ reason: "cancelled", key: "message" })
        const count = events.length
        context.stage("late")
        if (outcome === "resolve") response.resolve("late")
        else response.reject(new Error("late"))
        await Bun.sleep(1)
        expect(events).toHaveLength(count)
        expect(manager.values()).toEqual([])
        expect(operation.state.status).toBe(action === "confirm" ? "accepted" : "cancelled")
        expect(operation.accepted).toBe(action === "confirm" ? "canonical" : undefined)
        expect(context.signal.aborted).toBe(true)
      }
    },
  )

  test("confirmFrom uses canonical output, deduplicates in-flight lookups, and wins over HTTP failure", async () => {
    const response = Promise.withResolvers<string>()
    const canonical = Promise.withResolvers<string>()
    const invoked = Promise.withResolvers<void>()
    let loads = 0
    const manager = setup(() => async () => {
      invoked.resolve()
      return response.promise
    })
    const operation = manager.submit(input())
    await invoked.promise
    const load = async () => {
      loads++
      return canonical.promise
    }
    manager.confirmFrom(operation.key, load)
    operation.confirmFrom(load)
    response.reject(new Error("lost HTTP response"))
    await wait(() => loads === 1)
    expect(operation.accepted).toBeUndefined()
    canonical.resolve("canonical, not optimistic")
    await expect(operation.request).resolves.toBe("canonical, not optimistic")
    expect(loads).toBe(1)
    expect(manager.values()).toEqual([])
  })

  test("failed confirmation lookup retains proof and permits lookup retry after bounded transport exhaustion", async () => {
    const response = Promise.withResolvers<string>()
    const invoked = Promise.withResolvers<void>()
    const lookup = Promise.withResolvers<string>()
    let calls = 0
    const manager = setup(
      () => async () => {
        calls++
        invoked.resolve()
        return response.promise
      },
      {
        retry: { delays: [1], when: () => false },
      },
    )
    const operation = manager.submit(input())
    await invoked.promise
    operation.confirmFrom(() => lookup.promise)
    lookup.reject(new Error("lookup unavailable"))
    response.reject(new Error("not normally retryable"))
    await expect(operation.request).rejects.toMatchObject({ reason: "failed" })
    expect(calls).toBe(2)
    expect(operation.state.status).toBe("failed")
    expect(manager.get(operation.key)).toBe(operation)
    operation.confirmFrom(async () => "recovered canonical")
    await wait(() => operation.state.status === "accepted")
    expect(operation.accepted).toBe("recovered canonical")
    expect(manager.values()).toEqual([])
  })

  test("unsubscribe leaves work alive; dispose cancels requests, gates, lookups, and retained operations", async () => {
    const invoked = Promise.withResolvers<void>()
    const lookupStarted = Promise.withResolvers<AbortSignal>()
    const late = Promise.withResolvers<string>()
    const manager = setup((value) => async () => {
      if (value.id === "accepted") return "http"
      invoked.resolve()
      return new Promise(() => {})
    })
    let notifications = 0
    const unsubscribe = manager.subscribe(() => notifications++)
    const accepted = manager.submit(input("accepted", "accepted"))
    const running = manager.submit(input("running", "running"))
    const gated = manager.submit(input("gated"), { wait: new Promise(() => {}) })
    await Promise.all([accepted.request, invoked.promise])
    unsubscribe()
    const count = notifications
    running.confirmFrom(async (signal) => {
      lookupStarted.resolve(signal)
      return late.promise
    })
    const signal = await lookupStarted.promise
    expect(running.signal.aborted).toBe(false)
    manager.dispose()
    await expect(running.request).rejects.toMatchObject({ reason: "cancelled" })
    await expect(gated.request).rejects.toMatchObject({ reason: "cancelled" })
    await expect(accepted.request).rejects.toMatchObject({ reason: "cancelled" })
    expect(signal.aborted).toBe(true)
    expect(notifications).toBe(count)
    expect(manager.values()).toEqual([])
    expect(() => manager.submit(input("new"))).toThrow("disposed")
    late.resolve("too late")
    await Bun.sleep(1)
    expect(running.state.status).toBe("cancelled")
  })

  test("unused request rejections are internally observed without changing the returned rejection", async () => {
    const manager = setup(() => async () => {
      throw new Error("unused")
    })
    const operation = manager.submit(input())
    await wait(() => operation.state.status === "rejected")
    await expect(operation.request).rejects.toThrow("unused")
  })
})

async function wait(predicate: () => boolean) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return
    await Bun.sleep(1)
  }
  throw new Error("Timed out waiting for command state")
}

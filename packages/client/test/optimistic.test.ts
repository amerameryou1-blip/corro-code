import { expect, test } from "bun:test"
import { Optimistic } from "../src/optimistic"

test("local contributions preserve order, publish by group, and retire permanently", () => {
  const overlay = Optimistic.make<{ id: string; group: string; text: string }>({
    key: (value) => value.id,
    group: (value) => value.group,
  })
  const changed: string[] = []
  const unsubscribe = overlay.subscribe((group) => changed.push(group))
  overlay.set({ id: "a", group: "one", text: "First" })
  overlay.set({ id: "b", group: "one", text: "Second" })
  overlay.set({ id: "c", group: "two", text: "Independent" })
  overlay.set({ id: "a", group: "one", text: "Canonical payload" })
  expect(overlay.list("one").map((item) => item.id)).toEqual(["a", "b"])
  expect(overlay.get("a")?.text).toBe("Canonical payload")
  expect(changed).toEqual(["one", "one", "two", "one"])
  expect(overlay.remove("a")).toBe(true)
  expect(overlay.remove("a")).toBe(false)
  expect(overlay.has("a")).toBe(false)
  overlay.clear("one")
  expect(overlay.list("one")).toEqual([])
  expect(overlay.list("two")).toHaveLength(1)
  unsubscribe()
  overlay.clear("two")
  expect(changed.at(-1)).toBe("one")
})

test("authoritative rows win without cloning or changing their order", () => {
  const canonical = [
    { id: "b", text: "Server" },
    { id: "a", text: "Earlier" },
  ]
  const local = [
    { id: "b", text: "Guess" },
    { id: "c", text: "Pending" },
  ]
  const view = Optimistic.merge(canonical, local, (row) => row.id)
  expect(view.map((row) => row.id)).toEqual(["b", "a", "c"])
  expect(view[0]).toBe(canonical[0])
  expect(view[1]).toBe(canonical[1])
  expect(view[2]).toBe(local[1])
  expect(Optimistic.merge(canonical, [], (row) => row.id)).toBe(canonical)
  expect(Optimistic.merge(canonical, [local[0]], (row) => row.id)).toBe(canonical)
})

test("overlays cannot move an identity between owners", () => {
  const overlay = Optimistic.make<{ id: string; group: string }>({
    key: (item) => item.id,
    group: (item) => item.group,
  })
  overlay.set({ id: "a", group: "one" })
  expect(() => overlay.set({ id: "a", group: "two" })).toThrow("another group")
  expect(overlay.list("two")).toEqual([])
  expect(overlay.get("a")?.group).toBe("one")
})

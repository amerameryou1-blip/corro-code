export namespace Optimistic {
  /** Local contributions never write into the authoritative collection. */
  export function make<A extends object>(options: { key: (value: A) => string; group: (value: A) => string }) {
    const values = new Map<string, A>()
    const groups = new Map<string, readonly A[]>()
    const listeners = new Set<(group: string, values: readonly A[]) => void>()
    const empty: readonly A[] = []
    const publish = (group: string, next: readonly A[]) => {
      if (next.length) groups.set(group, next)
      else groups.delete(group)
      listeners.forEach((listener) => listener(group, next))
    }
    return {
      get: (key: string) => values.get(key),
      has: (key: string) => values.has(key),
      list: (group: string) => groups.get(group) ?? empty,
      set(value: A) {
        const key = options.key(value)
        const group = options.group(value)
        const previous = values.get(key)
        if (previous === value) return
        if (previous && options.group(previous) !== group) throw new Error("Optimistic key belongs to another group")
        values.set(key, value)
        const current = groups.get(group) ?? empty
        publish(
          group,
          previous ? current.map((item) => (options.key(item) === key ? value : item)) : [...current, value],
        )
      },
      remove(key: string) {
        const value = values.get(key)
        if (!value) return false
        values.delete(key)
        const group = options.group(value)
        publish(
          group,
          (groups.get(group) ?? empty).filter((item) => options.key(item) !== key),
        )
        return true
      },
      clear(group: string) {
        const current = groups.get(group)
        if (!current) return
        current.forEach((item) => values.delete(options.key(item)))
        publish(group, empty)
      },
      subscribe(listener: (group: string, values: readonly A[]) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
  }

  /** Preserve authoritative order and object identity; append only unmatched local values. */
  export function merge<A>(canonical: A[], local: readonly A[], key: (value: A) => string): A[] {
    if (!local.length) return canonical
    const known = new Set(canonical.map(key))
    const missing = local.filter((value) => !known.has(key(value)))
    return missing.length ? [...canonical, ...missing] : canonical
  }
}

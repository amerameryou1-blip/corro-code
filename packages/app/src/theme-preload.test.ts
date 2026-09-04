import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/oc-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: false,
      }) as MediaQueryList,
    configurable: true,
  })
})

describe("theme preload", () => {
  test("migrates legacy oc-1 and oc-2 to corro before mount", () => {
    for (const legacy of ["oc-1", "oc-2"]) {
      localStorage.clear()
      localStorage.setItem("opencode-theme-id", legacy)
      localStorage.setItem("opencode-theme-css-light", "--background-base:#fff;")
      localStorage.setItem("opencode-theme-css-dark", "--background-base:#000;")

      run()

      expect(document.documentElement.dataset.theme).toBe("opencode")
      expect(document.documentElement.dataset.colorScheme).toBe("light")
      expect(localStorage.getItem("opencode-theme-id")).toBe("opencode")
      expect(localStorage.getItem("opencode-theme-css-light")).toBeNull()
      expect(localStorage.getItem("opencode-theme-css-dark")).toBeNull()
      expect(document.getElementById("oc-theme-preload")).toBeNull()
    }
  })

  test("keeps cached css for non-default themes", () => {
    localStorage.setItem("opencode-theme-id", "nightowl")
    localStorage.setItem("opencode-theme-css-light", "--background-base:#fff;")

    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.getElementById("oc-theme-preload")?.textContent).toContain("--background-base:#fff;")
  })
})

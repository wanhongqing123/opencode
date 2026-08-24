import { describe, expect, test } from "bun:test"
import { createWin32MovedCellRepaint, win32RequestFullRepaint } from "../src/terminal-win32"

describe("Windows terminal repaint", () => {
  test("requests a full repaint on Windows", () => {
    let renders = 0
    const renderer = {
      forceFullRepaintRequested: false,
      requestRender() {
        renders++
      },
    }

    expect(win32RequestFullRepaint(renderer, "win32")).toBe(true)
    expect(renderer.forceFullRepaintRequested).toBe(true)
    expect(renders).toBe(1)
  })

  test("does not alter other platforms", () => {
    let renders = 0
    const renderer = {
      forceFullRepaintRequested: false,
      requestRender() {
        renders++
      },
    }

    expect(win32RequestFullRepaint(renderer, "darwin")).toBe(false)
    expect(renderer.forceFullRepaintRequested).toBe(false)
    expect(renders).toBe(0)
  })

  test("repaints once after scroll geometry changes", () => {
    let renders = 0
    const renderer = {
      forceFullRepaintRequested: false,
      requestRender() {
        renders++
      },
    }
    const repaint = createWin32MovedCellRepaint(renderer, "win32")
    const initial = { scrollTop: 10, scrollHeight: 100, width: 80, height: 24, scrollbarVisible: true }

    expect(repaint(initial)).toBe(false)
    expect(repaint(initial)).toBe(false)
    expect(repaint({ ...initial, scrollTop: 11 })).toBe(true)
    expect(repaint({ ...initial, scrollTop: 11 })).toBe(false)
    expect(repaint({ ...initial, scrollTop: 11, scrollbarVisible: false })).toBe(true)
    expect(renders).toBe(2)
  })
})

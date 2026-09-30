import { describe, expect, it } from "vitest";
import { fitTelegramPhotoDimensions } from "./index.js";

describe("Telegram photo dimensions", () => {
  it("fits oversized and extreme images within Telegram limits", () => {
    const oversized = fitTelegramPhotoDimensions(8_037, 7_000);
    expect(oversized.canvasWidth + oversized.canvasHeight).toBeLessThanOrEqual(10_000);
    expect(oversized.contentWidth).toBe(oversized.canvasWidth);
    expect(oversized.contentHeight).toBe(oversized.canvasHeight);

    const extreme = fitTelegramPhotoDimensions(10_000, 100);
    expect(extreme.canvasWidth + extreme.canvasHeight).toBeLessThanOrEqual(10_000);
    expect(extreme.canvasWidth / extreme.canvasHeight).toBeLessThanOrEqual(20);
    expect(extreme.contentHeight).toBeLessThan(extreme.canvasHeight);
  });
});

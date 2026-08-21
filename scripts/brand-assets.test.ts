import { describe, expect, test } from "bun:test";
import { PNG } from "pngjs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

describe("Dictum brand assets", () => {
  test("authored app icon uses the five-bar waveform on the core blue", async () => {
    const source = await Bun.file(
      path.join(repoRoot, "assets/branding/dictum-app-icon.svg"),
    ).text();

    expect(source).toContain('viewBox="0 0 512 512"');
    expect(source).toContain('fill="#1E40AF"');
    expect(source.match(/<rect /gu)).toHaveLength(6);
    expect(source).not.toContain("stroke=");
  });

  test("checked-in Windows and tray PNGs have their expected dimensions", async () => {
    const expectedDimensions = new Map<string, [number, number]>([
      ["src-tauri/icons/32x32.png", [32, 32]],
      ["src-tauri/icons/128x128.png", [128, 128]],
      ["src-tauri/icons/128x128@2x.png", [256, 256]],
      ["src-tauri/icons/icon.png", [512, 512]],
      ["src-tauri/icons/Square44x44Logo.png", [44, 44]],
      ["src-tauri/icons/Square310x310Logo.png", [310, 310]],
      ["src-tauri/resources/tray_idle.png", [64, 64]],
      ["src-tauri/resources/tray_idle_dark.png", [64, 64]],
      ["src-tauri/resources/tray_recording.png", [64, 64]],
      ["src-tauri/resources/tray_transcribing.png", [64, 64]],
    ]);

    for (const [relativePath, expected] of expectedDimensions) {
      const image = PNG.sync.read(
        Buffer.from(
          await Bun.file(path.join(repoRoot, relativePath)).arrayBuffer(),
        ),
      );
      expect([image.width, image.height]).toEqual(expected);
    }
  });

  test("generated app icon carries the Dictum blue and white waveform", async () => {
    const image = PNG.sync.read(
      Buffer.from(
        await Bun.file(
          path.join(repoRoot, "src-tauri/icons/icon.png"),
        ).arrayBuffer(),
      ),
    );
    const pixel = (x: number, y: number) => {
      const offset = (y * image.width + x) * 4;
      return [...image.data.subarray(offset, offset + 4)];
    };

    expect(pixel(256, 32)).toEqual([30, 64, 175, 255]);
    expect(pixel(256, 256)).toEqual([255, 255, 255, 255]);
    expect(pixel(0, 0)[3]).toBe(0);
  });
});

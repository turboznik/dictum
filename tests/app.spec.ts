import { expect, test, type Page } from "@playwright/test";

type AppMode = "accessibility" | "model" | "settings";

const installTauriMocks = async (page: Page, mode: AppMode) => {
  await page.addInitScript((requestedMode) => {
    let callbackId = 0;
    const callbacks = new Map<number, (...args: unknown[]) => void>();
    const settings = {
      onboarding_completed: requestedMode === "settings",
      app_language: "en",
      bindings: {
        transcribe: {
          id: "transcribe",
          name: "Transcribe Keyboard Shortcut",
          description: "Converts your speech into text.",
          default_binding: "ctrl+space",
          current_binding: "ctrl+space",
        },
      },
      selected_model: "small",
      selected_language: "auto",
      keyboard_implementation: "tauri",
      theme: "system",
      debug_mode: requestedMode === "settings",
      post_process_enabled: false,
      show_tray_icon: true,
    };

    Object.assign(window, {
      __TAURI_OS_PLUGIN_INTERNALS__: {
        platform: requestedMode === "model" ? "linux" : "windows",
        os_type: requestedMode === "model" ? "linux" : "windows",
        family: requestedMode === "model" ? "unix" : "windows",
        arch: "x86_64",
        version: "11",
        eol: "\r\n",
        exe_extension: "exe",
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: () => undefined,
      },
      __TAURI_INTERNALS__: {
        callbacks,
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: (callback: (...args: unknown[]) => void) => {
          callbackId += 1;
          callbacks.set(callbackId, callback);
          return callbackId;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        convertFileSrc: (filePath: string) => filePath,
        invoke: async (command: string) => {
          switch (command) {
            case "get_app_settings":
            case "get_default_settings":
              return settings;
            case "get_windows_microphone_permission_status":
              return {
                supported: true,
                overall_access:
                  requestedMode === "accessibility" ? "denied" : "allowed",
              };
            case "get_available_models":
            case "get_available_microphones":
            case "get_available_output_devices":
              return [];
            case "check_custom_sounds":
              return { start: false, stop: false };
            case "plugin:os|locale":
              return "en-US";
            case "get_app_dir_path":
              return "C:\\Users\\Tester\\AppData\\Roaming\\io.github.turboznik.dictum";
            case "get_log_dir_path":
              return "C:\\Users\\Tester\\AppData\\Roaming\\io.github.turboznik.dictum\\logs";
            case "get_debug_paths":
              return {
                app_data:
                  "C:\\Users\\Tester\\AppData\\Roaming\\io.github.turboznik.dictum",
                models:
                  "C:\\Users\\Tester\\AppData\\Roaming\\io.github.turboznik.dictum\\models",
                settings:
                  "C:\\Users\\Tester\\AppData\\Roaming\\io.github.turboznik.dictum\\settings_store.json",
                logs: "C:\\Users\\Tester\\AppData\\Roaming\\io.github.turboznik.dictum\\logs",
              };
            case "plugin:event|listen":
              return callbackId + 1;
            default:
              return null;
          }
        },
      },
    });
  }, mode);
};

test.describe("Dictum App", () => {
  test("dev server responds", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
  });

  test("settings sidebar presents the Dictum wordmark and neutral General icon", async ({
    page,
  }) => {
    await installTauriMocks(page, "settings");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto("/");

      await expect(page.getByTestId("dictum-wordmark")).toHaveText("Dictum");
      const generalSection = page.locator('[data-section-id="general"]');
      await expect(
        generalSection.getByTestId("general-settings-icon"),
      ).toBeVisible();

      const contrastRatio = await generalSection.evaluate((element) => {
        const parseRgb = (value: string) =>
          value
            .match(/\d+(?:\.\d+)?/gu)
            ?.slice(0, 3)
            .map(Number) ?? [];
        const luminance = (rgb: number[]) => {
          const linear = rgb.map((channel) => {
            const normalized = channel / 255;
            return normalized <= 0.04045
              ? normalized / 12.92
              : ((normalized + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
        };
        const style = getComputedStyle(element);
        const foreground = luminance(parseRgb(style.color));
        const background = luminance(parseRgb(style.backgroundColor));
        return (
          (Math.max(foreground, background) + 0.05) /
          (Math.min(foreground, background) + 0.05)
        );
      });
      expect(contrastRatio).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("permission onboarding presents the Dictum wordmark", async ({
    page,
  }) => {
    await installTauriMocks(page, "accessibility");
    await page.goto("/");

    await expect(page.getByTestId("dictum-wordmark")).toHaveText("Dictum");
  });

  test("debug settings report the resolved Dictum paths", async ({ page }) => {
    await installTauriMocks(page, "settings");
    await page.goto("/");
    await page.locator('[data-section-id="debug"]').click();

    await expect(
      page.getByText(
        "C:\\Users\\Tester\\AppData\\Roaming\\io.github.turboznik.dictum",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "C:\\Users\\Tester\\AppData\\Roaming\\io.github.turboznik.dictum\\models",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "C:\\Users\\Tester\\AppData\\Roaming\\io.github.turboznik.dictum\\logs",
        { exact: true },
      ),
    ).toBeVisible();
  });

  test("model onboarding presents the Dictum wordmark", async ({ page }) => {
    await installTauriMocks(page, "model");
    await page.goto("/");

    await expect(page.getByTestId("dictum-wordmark")).toHaveText("Dictum");
  });
});

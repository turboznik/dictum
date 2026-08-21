import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

const readText = (relativePath: string) =>
  Bun.file(path.join(repoRoot, relativePath)).text();

describe("Dictum product identity", () => {
  test("package and Windows bundle metadata establish an independent identity", async () => {
    const packageJson = await Bun.file(
      path.join(repoRoot, "package.json"),
    ).json();
    const tauriConfig = await Bun.file(
      path.join(repoRoot, "src-tauri", "tauri.conf.json"),
    ).json();
    const cargoToml = await readText("src-tauri/Cargo.toml");

    expect(packageJson.name).toBe("dictum-app");
    expect(packageJson.version).toBe("0.1.0");
    expect(tauriConfig.productName).toBe("Dictum");
    expect(tauriConfig.version).toBe("0.1.0");
    expect(tauriConfig.identifier).toBe("io.github.turboznik.dictum");
    expect(tauriConfig.bundle.publisher).toBe("turboznik");
    expect(tauriConfig.bundle.windows).not.toHaveProperty("signCommand");
    expect(cargoToml).toMatch(/^name = "dictum"$/m);
    expect(cargoToml).toMatch(/^version = "0\.1\.0"$/m);
    expect(cargoToml).toMatch(/^description = "Dictum"$/m);
    expect(cargoToml).toMatch(/^authors = \["turboznik"\]$/m);
    expect(cargoToml).toMatch(/^default-run = "dictum"$/m);
  });

  test("the intentionally deferred updater still targets Handy", async () => {
    const tauriConfig = await Bun.file(
      path.join(repoRoot, "src-tauri", "tauri.conf.json"),
    ).json();

    expect(tauriConfig.plugins.updater.endpoints).toEqual([
      "https://github.com/cjpais/Handy/releases/latest/download/latest.json",
    ]);
  });

  test("portable and installer identity cannot adopt Handy data", async () => {
    const portable = await readText("src-tauri/src/portable.rs");
    const installer = await readText("src-tauri/nsis/installer.nsi");
    const buildWorkflow = await readText(".github/_workflows/build.yml");

    expect(portable).not.toContain("upgrading legacy empty marker");
    expect(installer).not.toContain('${OrIf} $2 == ""');
    expect(installer).toContain(
      'VIAddVersionKey "CompanyName" "${MANUFACTURER}"',
    );
    expect(buildWorkflow).toContain(
      'Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Dictum"',
    );
    expect(buildWorkflow).toContain(
      'Join-Path $shell.SpecialFolders("Programs") "Dictum.lnk"',
    );
    expect(buildWorkflow).toContain(
      'Join-Path $shell.SpecialFolders("Desktop") "Dictum.lnk"',
    );
    expect(buildWorkflow).toContain(
      'Join-Path $roamingRoot "io.github.turboznik.dictum"',
    );
    expect(buildWorkflow).toContain("$secondInstance.WaitForExit(15000)");
  });

  test("maintained translations use Dictum except for the Handy Keys feature name", async () => {
    const localesDir = path.join(repoRoot, "src", "i18n", "locales");
    const localeDirectories = await readdir(localesDir, {
      withFileTypes: true,
    });
    const incorrectBranding: string[] = [];

    for (const localeDirectory of localeDirectories) {
      if (!localeDirectory.isDirectory()) continue;

      const locale = localeDirectory.name;
      const translationPath = path.join(localesDir, locale, "translation.json");
      const translation = await Bun.file(translationPath).text();
      for (const [lineIndex, line] of translation.split("\n").entries()) {
        if (/Handy(?! Keys)/u.test(line)) {
          incorrectBranding.push(`${locale}:${lineIndex + 1}`);
        }
      }
    }

    expect(incorrectBranding).toEqual([]);
  });
});

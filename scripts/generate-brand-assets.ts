import { PNG } from "pngjs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const checkOnly = process.argv.includes("--check");

const windowsIconFiles = [
  "32x32.png",
  "64x64.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.png",
  "icon.ico",
  "StoreLogo.png",
  "Square30x30Logo.png",
  "Square44x44Logo.png",
  "Square71x71Logo.png",
  "Square89x89Logo.png",
  "Square107x107Logo.png",
  "Square142x142Logo.png",
  "Square150x150Logo.png",
  "Square284x284Logo.png",
  "Square310x310Logo.png",
] as const;

type TrayState = "idle" | "recording" | "transcribing" | "warning";

interface WaveformBar {
  x: number;
  width: number;
  height: number;
  rx: number;
}

const trayTransforms: Record<
  TrayState,
  { order: readonly number[]; scale: readonly number[] }
> = {
  idle: { order: [0, 1, 2, 3, 4], scale: [1, 1, 1, 1, 1] },
  recording: {
    order: [0, 1, 2, 3, 4],
    scale: [0.72, 0.78, 0.92, 0.85, 0.88],
  },
  transcribing: {
    order: [1, 2, 0, 3, 1],
    scale: [0.78, 0.96, 1, 0.9, 0.78],
  },
  warning: { order: [0, 1, 2, 3, 4], scale: [1, 1, 1, 1, 1] },
};

const trayTargets = [
  { file: "tray_idle.png", state: "idle", color: "#FFFFFF" },
  { file: "tray_idle_dark.png", state: "idle", color: "#172554" },
  { file: "handy.png", state: "idle", color: "#1E40AF" },
  { file: "tray_recording.png", state: "recording", color: "#FFFFFF" },
  { file: "tray_recording_dark.png", state: "recording", color: "#172554" },
  { file: "recording.png", state: "recording", color: "#1E40AF" },
  {
    file: "tray_transcribing.png",
    state: "transcribing",
    color: "#FFFFFF",
  },
  {
    file: "tray_transcribing_dark.png",
    state: "transcribing",
    color: "#172554",
  },
  { file: "transcribing.png", state: "transcribing", color: "#1E40AF" },
  { file: "tray_idle_warning.png", state: "warning", color: "#FFFFFF" },
  {
    file: "tray_idle_warning_dark.png",
    state: "warning",
    color: "#172554",
  },
  { file: "handy_warning.png", state: "warning", color: "#1E40AF" },
] as const satisfies ReadonlyArray<{
  file: string;
  state: TrayState;
  color: string;
}>;

export const parseWaveformBars = (source: string): WaveformBar[] => {
  const waveform = source.match(
    /<g[^>]*id="waveform"[^>]*>([\s\S]*?)<\/g>/u,
  )?.[1];
  if (!waveform) throw new Error("App icon is missing the waveform group");

  const readAttribute = (attributes: string, name: string) => {
    const value = attributes.match(
      new RegExp(`\\b${name}="([^"]+)"`, "u"),
    )?.[1];
    if (value === undefined) throw new Error(`Waveform bar is missing ${name}`);
    return Number(value);
  };

  const bars = [...waveform.matchAll(/<rect\s+([^>]+)\/>/gu)].map(
    ([, attributes]) => ({
      x: readAttribute(attributes, "x"),
      width: readAttribute(attributes, "width"),
      height: readAttribute(attributes, "height"),
      rx: readAttribute(attributes, "rx"),
    }),
  );
  if (bars.length !== 5) {
    throw new Error(`Expected five waveform bars, found ${bars.length}`);
  }
  return bars;
};

export const traySvg = (
  state: TrayState,
  color: string,
  sourceBars: readonly WaveformBar[],
) => {
  const transform = trayTransforms[state];
  const minX = Math.min(...sourceBars.map(({ x }) => x));
  const maxX = Math.max(...sourceBars.map(({ x, width }) => x + width));
  const maxHeight = Math.max(...sourceBars.map(({ height }) => height));
  const xScale = 56 / (maxX - minX);
  const heightScale = 50 / maxHeight;
  const round = (value: number) => Math.round(value * 1000) / 1000;

  const bars = transform.order
    .map((sourceIndex, index) => {
      const position = sourceBars[index];
      const amplitude = sourceBars[sourceIndex];
      const x = round(4 + (position.x - minX) * xScale);
      const width = round(position.width * xScale);
      const height = round(
        amplitude.height * heightScale * transform.scale[index],
      );
      const y = (64 - height) / 2;
      const rx = round(Math.min(width / 2, position.rx * xScale));
      return `<rect x="${x}" y="${round(y)}" width="${width}" height="${height}" rx="${rx}"/>`;
    })
    .join("");
  const recordingDot =
    state === "recording"
      ? '<circle cx="54" cy="52" r="7" fill="#DC2626"/>'
      : "";
  const warningBadge =
    state === "warning"
      ? '<circle cx="52" cy="12" r="10" fill="#FBBF24"/><rect x="50" y="6" width="4" height="8" rx="2" fill="#172554"/><rect x="50" y="16" width="4" height="4" rx="2" fill="#172554"/>'
      : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="${color}">${bars}</g>${recordingDot}${warningBadge}</svg>`;
};

const runTauriIcon = async (input: string, output: string, pngOnly = false) => {
  const arguments_ = [
    process.execPath,
    "run",
    "tauri",
    "icon",
    input,
    "--output",
    output,
  ];
  if (pngOnly) arguments_.push("--png", "64");

  const process_ = Bun.spawn(arguments_, {
    cwd: repoRoot,
    stdout: "ignore",
    stderr: "inherit",
  });
  const exitCode = await process_.exited;
  if (exitCode !== 0) {
    throw new Error(`Tauri icon generation failed for ${input}`);
  }
};

const pngPixelsEqual = async (generated: string, committed: string) => {
  const [generatedPng, committedPng] = await Promise.all([
    readFile(generated).then(PNG.sync.read),
    readFile(committed).then(PNG.sync.read),
  ]);
  return (
    generatedPng.width === committedPng.width &&
    generatedPng.height === committedPng.height &&
    generatedPng.data.equals(committedPng.data)
  );
};

const filesEqual = async (generated: string, committed: string) => {
  const [generatedBytes, committedBytes] = await Promise.all([
    readFile(generated),
    readFile(committed),
  ]);
  return generatedBytes.equals(committedBytes);
};

const publishOrCheck = async (
  generated: string,
  committed: string,
  drift: string[],
) => {
  if (!checkOnly) {
    await mkdir(path.dirname(committed), { recursive: true });
    await copyFile(generated, committed);
    return;
  }

  try {
    const matches = committed.endsWith(".png")
      ? await pngPixelsEqual(generated, committed)
      : await filesEqual(generated, committed);
    if (!matches) drift.push(path.relative(repoRoot, committed));
  } catch {
    drift.push(path.relative(repoRoot, committed));
  }
};

const generate = async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "dictum-brand-"));
  const appOutput = path.join(temporaryRoot, "app");
  const trayOutput = path.join(temporaryRoot, "tray");
  const drift: string[] = [];

  try {
    const appIconSource = path.join(
      repoRoot,
      "assets/branding/dictum-app-icon.svg",
    );
    const waveformBars = parseWaveformBars(
      await readFile(appIconSource, "utf8"),
    );
    await mkdir(appOutput, { recursive: true });
    await mkdir(trayOutput, { recursive: true });
    await runTauriIcon(appIconSource, appOutput);

    await Promise.all(
      trayTargets.map(async ({ file, state, color }) => {
        const source = path.join(temporaryRoot, `${file}.svg`);
        const output = path.join(trayOutput, file.replace(/\.png$/u, ""));
        await writeFile(source, traySvg(state, color, waveformBars), "utf8");
        await mkdir(output, { recursive: true });
        await runTauriIcon(source, output, true);
      }),
    );

    for (const file of windowsIconFiles) {
      await publishOrCheck(
        path.join(appOutput, file),
        path.join(repoRoot, "src-tauri/icons", file),
        drift,
      );
    }

    for (const { file } of trayTargets) {
      await publishOrCheck(
        path.join(trayOutput, file.replace(/\.png$/u, ""), "64x64.png"),
        path.join(repoRoot, "src-tauri/resources", file),
        drift,
      );
    }

    if (drift.length > 0) {
      throw new Error(
        `Generated brand assets have drifted:\n${drift.map((file) => `- ${file}`).join("\n")}`,
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  await generate();
  console.log(
    checkOnly
      ? "Dictum brand assets match their generated sources."
      : "Generated Dictum Windows and tray assets.",
  );
}

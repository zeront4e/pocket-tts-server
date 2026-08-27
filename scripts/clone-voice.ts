#!/usr/bin/env bun
// Usage: bun run scripts/clone-voice.ts <reference_audio> [voice_name] [--lang de|en]
// Example: bun run scripts/clone-voice.ts /path/to/my_recording.wav meine_stimme --lang en

import { resolve, basename, extname } from "path";
import {
  type Lang,
  getEffectiveConfigPath,
  customVoiceDir,
  customVoicePath,
  normalizeLang,
  getDefaultLang,
} from "../src/config.js";
import { getUvPath } from "../src/utils.js";

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    process.exit(args.length < 1 ? 1 : 0);
  }

  let lang: Lang = getDefaultLang();

  const langFlag = args.findIndex((a) => a === "--lang" || a === "--language");

  if (langFlag !== -1) {
    const value = args[langFlag + 1];

    const parsed = value ? normalizeLang(value) : null;

    if (!parsed) {
      console.error(`Error: --lang requires 'de' or 'en' (got ${value ?? "nothing"})`);

      process.exit(1);
    }

    lang = parsed;
  }

  const positional = langFlag === -1 ? args : args.filter((_, i) => i !== langFlag && i !== langFlag + 1);

  const audioPath = resolve(positional[0]);
  const defaultName = basename(audioPath).replace(extname(audioPath), "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const voiceName = positional[1] ?? defaultName;

  if (!/^[a-zA-Z0-9_-]+$/.test(voiceName)) {
    console.error(`Error: Voice name "${voiceName}" must be alphanumeric with hyphens/underscores.`);
    process.exit(1);
  }

  const file = Bun.file(audioPath);
  if (!(await file.exists())) {
    console.error(`Error: File not found: ${audioPath}`);
    process.exit(1);
  }

  const ext = extname(audioPath).toLowerCase();
  if (![".wav", ".mp3"].includes(ext)) {
    console.error(`Error: Only .wav and .mp3 files are supported (got ${ext})`);
    process.exit(1);
  }

  const size = file.size;
  const configPath = await getEffectiveConfigPath(lang);

  console.log(`Reference audio:  ${audioPath}`);
  console.log(`File size:        ${(size / 1024).toFixed(1)} KB`);
  console.log(`Voice name:       ${voiceName}`);
  console.log(`Language:         ${lang}`);
  console.log(`Config:           ${configPath}`);
  console.log("");

  console.log("Cloning voice... (this can take 30s+ depending on audio length)");
  console.log("");

  const voicesPath = customVoiceDir(lang);

  Bun.spawnSync(["mkdir", "-p", voicesPath]);
  
  const destPath = customVoicePath(voiceName, lang);

  const proc = Bun.spawn(
    [
      getUvPath(), "run",
      "pocket-tts", "export-voice",
      audioPath, destPath,
      "--config", configPath,
    ],
    {
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  const code = await proc.exited;

  if (code !== 0) {
    console.error(`\nError: Voice cloning failed (exit code ${code})`);

    process.exit(1);
  }

  const result = Bun.file(destPath);

  console.log(`\nSuccess! Voice saved to: ${destPath}`);
  console.log(`  Size: ${(result.size / 1024).toFixed(1)} KB`);
  console.log("");
  
  const testText = lang === "en" ? "Hello, I am my new voice!" : "Hallo, ich bin meine neue Stimme!";

  console.log("Test it:");
  console.log(`  curl -X POST http://localhost:3001/tts \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"text": "${testText}", "voice": "${voiceName}", "lang": "${lang}"}' \\`);
  console.log(`    -o test.wav`);
  console.log("");
  
  console.log("Or from the API endpoint:");
  console.log(`  {"text": "...", "voice": "${voiceName}", "lang": "${lang}"}  →  POST /tts`);
}

function printUsage() {
  console.log(`
PocketTTS Voice Cloning

Usage:
  bun run scripts/clone-voice.ts <reference_audio> [voice_name] [--lang de|en]

Arguments:
  reference_audio   Path to a .wav or .mp3 file (5-30s of clean speech recommended)
  voice_name        Name for the cloned voice (default: audio filename without extension)

Options:
   --lang <de|en>    Language of the clone (default: the server's DEFAULT_LANGUAGE).
                     German clones go to voices/de/<name>.safetensors, English ones to
                     voices/en/<name>.safetensors. Clones are NOT interchangeable
                     between languages, synthesize with the same "lang".
  -h, --help        Show this help

Examples:
  bun run scripts/clone-voice.ts /path/to/memo.wav
  bun run scripts/clone-voice.ts /path/to/recording.mp3 meine_stimme
  bun run scripts/clone-voice.ts /path/to/recording.mp3 my_voice --lang en

Use it in API requests: { "text": "...", "voice": "<name>", "lang": "<lang>" }
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);

  process.exit(1);
});

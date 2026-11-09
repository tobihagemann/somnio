import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WEB_ROOT } from './helpers/paths';

/**
 * The files the client loads from the asset pack's `UI/`. Neither the chrome nor the HUD's icons
 * has a fallback: a missing border draws a panel as a bare box, and a missing icon draws its control
 * blank, since the icon is a mask with nothing to show. `Scripts/bundle-web-assets.sh` names each file
 * in `UI_FILES` and fails on a missing one, and CI's pack check names them again. This holds both lists
 * to what the client references, so a new icon cannot ship without them.
 */

const REPO_ROOT = resolve(WEB_ROOT, '..', '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|css|html)$/.test(entry.name) ? [path] : [];
  });
}

/** Every `UI/` file named by an `/assets/UI/...` URL in the client's sources and its page. */
function referencedFiles(): string[] {
  const texts = [...sourceFiles(resolve(WEB_ROOT, 'src')), resolve(WEB_ROOT, 'index.html')].map((path) => readFileSync(path, 'utf8'));
  return [...new Set(texts.flatMap((text) => [...text.matchAll(/\/assets\/UI\/([\w.-]+)/g)].map((match) => match[1]!)))].sort();
}

function bundledFiles(): string[] {
  const script = readFileSync(resolve(REPO_ROOT, 'Scripts/bundle-web-assets.sh'), 'utf8');
  const list = /\nUI_FILES=\(\n([^)]*)\)/.exec(script)?.[1];
  expect(list).toBeDefined();
  return [...list!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!).sort();
}

function checkedInCI(): string[] {
  const workflow = readFileSync(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  const loop = /for file in ([^;]+); do\n\s*if \[\[ ! -f "assets\/UI\/\$\{file\}" \]\]/.exec(workflow)?.[1];
  expect(loop).toBeDefined();
  return loop!.trim().split(/\s+/).sort();
}

describe('the UI files the client loads', () => {
  it('are each named once in the bundle script, and nothing else is', () => {
    const bundled = bundledFiles();
    expect(new Set(bundled).size).toBe(bundled.length);
    expect(bundled).toEqual(referencedFiles());
  });

  it("are each named in CI's pack check", () => {
    expect(checkedInCI()).toEqual(bundledFiles());
  });

  it('are the chrome and the HUD icons', () => {
    // Pinned so the scan above cannot pass by finding nothing at all.
    expect(referencedFiles()).toEqual(expect.arrayContaining(['panel-primary.png', 'panel-button.png', 'icon-sword.png', 'icon-close.png']));
  });
});

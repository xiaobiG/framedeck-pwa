import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = index.match(/<style>([\s\S]*?)<\/style>/)[1];
const icon = await readFile(new URL('../assets/icon.svg', import.meta.url), 'utf8');

function colorToken(name) {
  const match = css.match(new RegExp(`${name}: (#[0-9a-f]{6});`));
  assert.ok(match, `Missing color token ${name}`);
  return match[1];
}

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels.reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
}

function contrast(a, b) {
  const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (light + 0.05) / (dark + 0.05);
}

test('coral primary buttons have readable text in every enabled interaction state', () => {
  assert.equal(colorToken('--fd-accent'), '#ff7f6e');
  for (const name of ['--fd-accent', '--fd-accent-hover', '--fd-accent-pressed']) {
    assert.ok(contrast(colorToken(name), colorToken('--fd-on-accent')) >= 4.5, name);
  }
});

test('light theme uses a deeper coral for text, outlines and focus', () => {
  const ink = colorToken('--fd-accent-ink');
  for (const surface of ['#ffffff', '#f7f9fb', '#edf1f5']) {
    assert.ok(contrast(ink, surface) >= 4.5, `${ink} against ${surface}`);
  }
  assert.match(css, /:root,\s*body\[data-theme\] \{[^}]*--fd-accent-soft:/);
  assert.match(css, /outline: 2px solid var\(--fd-accent-ink\)/);
});

test('legacy blue accent literals are absent from the styles and brand icon', () => {
  const blue = /#(?:4a90e2|357abd|2f7df6|4b8fff|1767d1|2168df|a9ccff)\b|rgba?\(\s*(?:74,\s*144,\s*226|47,\s*125,\s*246|23,\s*103,\s*209)\s*[,)]/i;
  assert.doesNotMatch(css, blue);
  assert.doesNotMatch(icon, blue);
});

test('media canvas and semantic status colors remain independent of the coral accent', () => {
  assert.match(css, /\.media-area \{[^}]*background: #070a0e;/);
  assert.match(css, /body\.is-fullscreen \{\s*background: #000;/);
  assert.equal(colorToken('--fd-danger'), '#ff5f67');
  assert.equal(colorToken('--fd-success'), '#45c779');
  assert.match(css, /\.pwa-status\.is-offline i \{\s*background: #f3aa3d;/);
});

test('coral app icons keep the manifest raster sizes', async () => {
  assert.ok(icon.includes(colorToken('--fd-accent-hover')));
  assert.ok(icon.includes(colorToken('--fd-accent-pressed')));
  for (const size of [192, 512]) {
    const png = await readFile(new URL(`../assets/icon-${size}.png`, import.meta.url));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});

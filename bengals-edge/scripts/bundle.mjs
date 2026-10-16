#!/usr/bin/env node
// Builds the two front-end outputs from src/app.html:
//   public/index.html      — full HTML page that loads public/data.json at runtime (host this, e.g. GitHub Pages)
//   dist/standalone.html   — single file with the data baked in (open it anywhere, no server needed)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(ROOT, 'src', 'app.html'), 'utf8');

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${app}
</body>
</html>
`;
writeFileSync(join(ROOT, 'public', 'index.html'), page);

const data = readFileSync(join(ROOT, 'public', 'data.json'), 'utf8').replace(/</g, '\\u003c');
const inject = `<script>window.__DATA__=${data};</script>\n`;
const idx = app.indexOf('<script>');
const standalone = app.slice(0, idx) + inject + app.slice(idx);
mkdirSync(join(ROOT, 'dist'), { recursive: true });
writeFileSync(join(ROOT, 'dist', 'standalone.html'), standalone);
console.log('Wrote public/index.html and dist/standalone.html');

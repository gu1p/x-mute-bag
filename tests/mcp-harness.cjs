// Builds a Chrome-MCP-compatible browser harness when launching Chromium is unavailable.
// Production source is unchanged; Chrome APIs and X responses are simulated in iframes.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const sources = Object.fromEntries(['core.js', 'background.js', 'x-adapter.js', 'content.js'].map(f => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
const fixture = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
const harness = fs.readFileSync(path.join(__dirname, 'mcp-harness-runtime.js'), 'utf8');
fs.mkdirSync(path.join(root, 'artifacts'), {recursive: true});
fs.writeFileSync(path.join(root, 'artifacts', 'mcp-harness.js'), '(' + harness + ')(' + JSON.stringify(sources) + ',' + JSON.stringify(fixture) + ');');
console.log(path.join(root, 'artifacts', 'mcp-harness.js'));

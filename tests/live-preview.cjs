// Builds a UI-only preview for Chrome MCP. All Apply requests are rejected.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const bridge = [
  'let listener;',
  'const preview = {account: XMuteX.account(), bag: [], options: {...XMuteCore.DEFAULTS}, job: null};',
  'globalThis.XMBPreview = preview;',
  'const chrome = {storage: {onChanged: {addListener() {}}}, runtime: {',
  'onMessage: {addListener(fn) {listener=fn;}},',
  'async sendMessage(m) {try {',
  'if(m.type === "runner:discover") return {ok:true,value:null};',
  'if(m.type === "pick") {const result=XMuteCore.pick(preview.bag,m.text,m.replace);preview.bag=result.bag;return {ok:true,value:{...structuredClone(preview),selection:result.selection}};}',
  'if(m.type === "add") preview.bag=XMuteCore.add(preview.bag,m.text);',
  'else if(m.type === "edit") preview.bag=XMuteCore.edit(preview.bag,m.id,m.text);',
  'else if(m.type === "remove") preview.bag=preview.bag.filter(i=>i.id!==m.id);',
  'else if(m.type === "clear") preview.bag=[];',
  'else if(m.type === "options") preview.options=XMuteCore.options(m.options);',
  'else if(m.type !== "view") throw Error("Preview only. Load the extension to apply muted words.");',
  'return {ok:true,value:structuredClone(preview)};',
  '}catch(e){return {ok:false,error:e.message};}}}};',
].join('\n');
const script = '(() => {\n' + read('core.js') + '\n' + read('x-adapter.js') + '\n' + bridge + '\n' + read('content.js') +
  '\nlistener({type:"TOGGLE"},{},()=>{}); return {preview:true,applyDisabled:true};\n})()';
fs.mkdirSync(path.join(root, 'artifacts'), {recursive: true});
fs.writeFileSync(path.join(root, 'artifacts', 'live-preview.js'), script);
console.log(path.join(root, 'artifacts', 'live-preview.js'));

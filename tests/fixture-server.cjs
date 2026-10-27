const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

module.exports = async function startFixtureServer(model, fixture) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xmb-test-tls-'));
  let tls;
  try {
    const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
      '-out', cert, '-days', '1', '-subj', '/CN=x.com'], {stdio: 'ignore'});
    tls = {key: fs.readFileSync(key), cert: fs.readFileSync(cert)};
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
  const server = https.createServer(tls, async (request, response) => {
    const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    response.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(request.url, 'https://x.com');
      if (url.pathname === '/__fixture/state') return json({account: model.account, words: model.words, spa: !!model.spa, fullAdd: !!model.fullAdd, listDelay: model.listDelay || 0});
      if (url.pathname === '/__fixture/save') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const value = JSON.parse(Buffer.concat(chunks).toString());
        model.saveTimes?.push(Date.now());
        model.saves.push(value);
        if (model.saveDelay) await new Promise(resolve => setTimeout(resolve, model.saveDelay));
        if (model.fail === value.text) return json({error: 'Try again later: fixture failure'});
        if (model.words.some(word => word.text.toLowerCase() === value.text.toLowerCase())) return json({error: 'This word is already muted'});
        model.words.push(value);
        if (model.uncertain === value.text) return json({error: 'Try again: saved but response lost'});
        return json({ok: true});
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (request.headers['sec-fetch-dest'] === 'document') model.documents?.push(url.pathname);
      response.end(fixture);
    } catch (error) { response.statusCode = 500; response.end(error.message); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    port: server.address().port,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
};

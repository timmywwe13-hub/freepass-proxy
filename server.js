const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');
const fs = require('fs');

// Render.com sets PORT env variable - fall back to 3000 for local
const PORT = process.env.PORT || 3000;

function serveHTML(res) {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

function rewriteContent(body, targetUrl, hostUrl) {
  const base = new URL(targetUrl);
  const origin = base.origin;
  const proxyBase = `${hostUrl}/proxy?url=`;

  // Rewrite root-relative paths
  body = body.replace(/(href|src|action)="(\/[^"]*?)"/g, (_, attr, p) => {
    return `${attr}="${proxyBase}${encodeURIComponent(origin + p)}"`;
  });
  body = body.replace(/(href|src|action)='(\/[^']*?)'/g, (_, attr, p) => {
    return `${attr}='${proxyBase}${encodeURIComponent(origin + p)}'`;
  });

  // Rewrite protocol-relative URLs
  body = body.replace(/(href|src)="(\/\/[^"]*?)"/g, (_, attr, p) => {
    return `${attr}="${proxyBase}${encodeURIComponent('https:' + p)}"`;
  });

  // Rewrite same-origin absolute URLs
  const esc = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  body = body.replace(new RegExp(`(href|src)="${esc}([^"]*?)"`, 'g'), (_, attr, p) => {
    return `${attr}="${proxyBase}${encodeURIComponent(origin + p)}"`;
  });

  return body;
}

function proxyRequest(targetUrl, clientReq, clientRes, hostUrl) {
  let parsed;
  try { parsed = new URL(targetUrl); }
  catch {
    clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
    clientRes.end('Invalid URL');
    return;
  }

  const lib = parsed.protocol === 'https:' ? https : http;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',
      'Host': parsed.hostname,
      'Connection': 'keep-alive',
    },
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    const status = proxyRes.statusCode;
    const ct = proxyRes.headers['content-type'] || '';

    // Handle redirects
    if ([301,302,303,307,308].includes(status) && proxyRes.headers.location) {
      let loc = proxyRes.headers.location;
      if (loc.startsWith('/')) loc = parsed.origin + loc;
      else if (loc.startsWith('//')) loc = parsed.protocol + loc;
      clientRes.writeHead(302, { 'Location': `${hostUrl}/proxy?url=${encodeURIComponent(loc)}` });
      clientRes.end();
      return;
    }

    // Non-HTML: pass through directly
    if (!ct.includes('text/html')) {
      const headers = { ...proxyRes.headers };
      delete headers['x-frame-options'];
      delete headers['content-security-policy'];
      delete headers['strict-transport-security'];
      clientRes.writeHead(status, headers);
      proxyRes.pipe(clientRes);
      return;
    }

    // HTML: collect, rewrite, inject toolbar
    let body = '';
    proxyRes.setEncoding('utf8');
    proxyRes.on('data', chunk => { body += chunk; });
    proxyRes.on('end', () => {
      body = rewriteContent(body, targetUrl, hostUrl);

      const toolbar = `
<div id="__fp" style="position:fixed;top:0;left:0;right:0;z-index:999999;background:#0a0a0f;color:#00f5a0;font-family:monospace;font-size:13px;padding:6px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #1e1e2e;box-shadow:0 2px 12px #000;">
  <span style="font-weight:bold;white-space:nowrap;">🔓 FreePass</span>
  <span style="color:#6b6b80;white-space:nowrap;display:none;">proxying</span>
  <input id="__fp_input" type="text" value="${targetUrl}" style="background:#12121a;border:1px solid #1e1e2e;color:#e8e8f0;font-family:monospace;font-size:12px;padding:3px 8px;border-radius:6px;flex:1;outline:none;min-width:0;" onkeydown="if(event.key==='Enter'){var v=this.value.trim();if(!v.startsWith('http'))v='https://'+v;window.location='${hostUrl}/proxy?url='+encodeURIComponent(v);}"/>
  <a href="${hostUrl}" style="color:#00f5a0;text-decoration:none;border:1px solid #1e1e2e;padding:3px 10px;border-radius:6px;white-space:nowrap;font-size:12px;">← Home</a>
</div>
<div style="height:34px;"></div>`;

      body = body.replace(/<body[^>]*>/i, m => m + toolbar);

      clientRes.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      clientRes.end(body);
    });
  });

  proxyReq.on('error', err => {
    clientRes.writeHead(502, { 'Content-Type': 'text/html' });
    clientRes.end(`<div style="font-family:monospace;padding:2rem;background:#0a0a0f;color:#ff4d6d;min-height:100vh;">
      <h2>❌ Proxy Error</h2>
      <p style="color:#6b6b80;margin-top:1rem;">${err.message}</p>
      <p style="margin-top:1rem;"><a href="${hostUrl}" style="color:#00f5a0;">← Go back</a></p>
    </div>`);
  });

  proxyReq.setTimeout(15000, () => proxyReq.destroy());
  proxyReq.end();
}

const server = http.createServer((req, clientRes) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Detect host URL so links work whether local or on Render
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const hostUrl = `${proto}://${host}`;

  if (pathname === '/' || pathname === '/index.html') return serveHTML(clientRes);

  if (pathname === '/proxy') {
    const target = parsed.query.url;
    if (!target) {
      clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
      return clientRes.end('Missing ?url=');
    }
    return proxyRequest(decodeURIComponent(target), req, clientRes, hostUrl);
  }

  clientRes.writeHead(404);
  clientRes.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n🔓 FreePass running on port ${PORT}\n`);
});

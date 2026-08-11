// Small request/response helpers shared by every route file (app.js's own
// inline routes and authRoutes.js) — extracted from app.js so a second
// route file doesn't have to duplicate them. No framework, matching this
// server's own "deliberately plain Node http" design (see app.js's module
// comment).

export const readJsonBody = (req) => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (!raw) return resolve({});
    try {
      resolve(JSON.parse(raw));
    } catch (err) {
      reject(err);
    }
  });
  req.on('error', reject);
});

export const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

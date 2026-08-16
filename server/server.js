/* ============================================================
   Campus Market — server entry point
   Run with:  node server/server.js   (or: npm start)
   No external dependencies — only Node's built-in modules.
   ============================================================ */
'use strict';

const { createServer } = require('./app');

const server = createServer();
const PORT = process.env.PORT || 3000;

const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  🛒  Campus Market server running');
  console.log(`  ➜  http://${HOST}:${PORT}`);
  console.log('');
});

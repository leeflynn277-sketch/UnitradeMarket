const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createServer } = require('../server/app');

function loadApiClient(location) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'api.js'), 'utf8');
  const context = {
    window: { location },
    localStorage: {
      store: {},
      getItem(key) { return this.store[key] ?? null; },
      setItem(key, value) { this.store[key] = String(value); },
      removeItem(key) { delete this.store[key]; },
    },
    console,
    fetch: async () => { throw new Error('unexpected fetch'); },
  };

  vm.createContext(context);
  vm.runInContext(code + '\nthis.Api = Api;', context);
  return context.Api;
}

function loadAppScript(search = '?id=42') {
  const code = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'app.js'), 'utf8');
  const context = {
    window: {
      location: { search, pathname: '/product.html', href: `http://localhost/product.html${search}` },
      history: { length: 1 },
    },
    document: {
      addEventListener() {},
      querySelectorAll() { return []; },
      createElement() {
        return {
          style: {},
          className: '',
          textContent: '',
          appendChild() {},
          setAttribute() {},
          addEventListener() {},
          querySelector() { return null; },
          querySelectorAll() { return []; },
        };
      },
      body: { appendChild() {} },
    },
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    location: { search, pathname: '/product.html', href: `http://localhost/product.html${search}` },
  };

  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

test('reads the selected product id from the query string', () => {
  const context = loadAppScript('?id=42');
  assert.equal(context.cmParam('id'), '42');
});

test('falls back to the local backend for localhost dev servers', () => {
  const api = loadApiClient({ protocol: 'http:', hostname: 'localhost', port: '8000' });
  assert.equal(api.resolveApiBase(), 'http://127.0.0.1:3000');
  assert.equal(api.resolveApiUrl('/api/auth/login'), 'http://127.0.0.1:3000/api/auth/login');
});

test('profile picture uploads update the signed-in user', async () => {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dataDir = path.join(__dirname, '..', 'server', 'tmp-data', unique);
  process.env.CAMPUS_MARKET_DATA_DIR = dataDir;
  process.env.CAMPUS_MARKET_SECRET_PATH = path.join(dataDir, 'secret.key');

  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  try {
    const signupRes = await fetch(`http://127.0.0.1:${address.port}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Photo User',
        email: `photo-${unique}@example.com`,
        studentId: `UEB${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}22`,
        password: 'supersecret123',
      }),
    });
    assert.equal(signupRes.status, 201);
    const signupBody = await signupRes.json();

    const uploadRes = await fetch(`http://127.0.0.1:${address.port}/api/auth/profile-picture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signupBody.token}`,
      },
      body: JSON.stringify({ image: 'data:image/png;base64,AA==' }),
    });

    assert.equal(uploadRes.status, 200);
    const uploadBody = await uploadRes.json();
    assert.match(uploadBody.user.avatarUrl, /^\/uploads\//);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('sellers cannot buy their own listings; buyers can, but only once', async () => {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dataDir = path.join(__dirname, '..', 'server', 'tmp-data', unique);
  process.env.CAMPUS_MARKET_DATA_DIR = dataDir;
  process.env.CAMPUS_MARKET_SECRET_PATH = path.join(dataDir, 'secret.key');

  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    let studentSeq = 0;
    async function signup(label) {
      studentSeq += 1;
      const res = await fetch(`${base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: label,
          email: `${label.toLowerCase()}-${unique}@example.com`,
          studentId: `UEB${String(studentSeq).padStart(5, '0')}22`,
          password: 'supersecret123',
        }),
      });
      assert.equal(res.status, 201);
      return res.json();
    }

    const sellerA = await signup('SellerA');
    const buyerB = await signup('BuyerB');
    const buyerC = await signup('BuyerC');

    // Approve seller A so they're allowed to list an item (fresh accounts start pending).
    const db = require('../server/lib/db');
    db.prepare("UPDATE users SET account_status = 'approved', can_sell = 1 WHERE id = ?").run(sellerA.user.id);

    const listingRes = await fetch(`${base}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sellerA.token}` },
      body: JSON.stringify({ title: 'Self-Purchase Test Item', category: 'misc', price: 10, description: 'test' }),
    });
    assert.equal(listingRes.status, 201);
    const { product } = await listingRes.json();

    // Seller A tries to buy their own listing -> 403.
    const selfBuyRes = await fetch(`${base}/api/cart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sellerA.token}` },
      body: JSON.stringify({ productId: product.id, qty: 1 }),
    });
    assert.equal(selfBuyRes.status, 403);

    // Buyer B adds it to cart and checks out -> succeeds, listing becomes unavailable.
    const addCartRes = await fetch(`${base}/api/cart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerB.token}` },
      body: JSON.stringify({ productId: product.id, qty: 1 }),
    });
    assert.equal(addCartRes.status, 201);

    const orderRes = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerB.token}` },
      body: JSON.stringify({ zone: { name: 'UENR Library' }, meetupTime: 'Tomorrow 3pm' }),
    });
    assert.equal(orderRes.status, 201);

    // Buyer C tries to buy the now-sold item -> 409 Conflict.
    const lateBuyRes = await fetch(`${base}/api/cart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerC.token}` },
      body: JSON.stringify({ productId: product.id, qty: 1 }),
    });
    assert.equal(lateBuyRes.status, 409);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('health endpoint and signup work', async () => {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dataDir = path.join(__dirname, '..', 'server', 'tmp-data', unique);
  process.env.CAMPUS_MARKET_DATA_DIR = dataDir;
  process.env.CAMPUS_MARKET_SECRET_PATH = path.join(dataDir, 'secret.key');

  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  try {
    const healthRes = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthBody = await healthRes.json();
    assert.equal(healthBody.status, 'ok');

    const signupRes = await fetch(`http://127.0.0.1:${address.port}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Smoke Tester',
        email: `smoke-${unique}@example.com`,
        studentId: `UEB${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}22`,
        password: 'supersecret123',
      }),
    });

    assert.equal(signupRes.status, 201);
    const signupBody = await signupRes.json();
    assert.ok(signupBody.token);
    assert.ok(signupBody.user);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

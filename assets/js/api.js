/* ============================================================
   Campus Market — API client
   Thin wrapper around fetch() for talking to the real backend
   (server/server.js). Handles auth tokens, JSON, and errors.
   ============================================================ */

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const Api = (() => {
  function getToken() {
    return localStorage.getItem('cm_token');
  }

  function resolveApiBase() {
    const explicit = (window.__CAMPUS_MARKET_API_BASE__ || window.CAMPUS_MARKET_API_BASE || '').trim();
    if (explicit) return explicit.replace(/\/$/, '');

    if (typeof window !== 'undefined' && window.location) {
      const { protocol, hostname, port } = window.location;
      const hasHttpOrigin = protocol === 'http:' || protocol === 'https:';
      const isLocalDevServer = hostname === 'localhost' || hostname === '127.0.0.1';
      const isCommonFrontendPort = ['5500', '5501', '8000', '8080'].includes(port);

      if (!hasHttpOrigin || !hostname) {
        return 'http://127.0.0.1:3000';
      }
      if (isLocalDevServer && isCommonFrontendPort) {
        return 'http://127.0.0.1:3000';
      }
      if (isLocalDevServer) {
        return `${protocol}//127.0.0.1:3000`;
      }
      return `${protocol}//${hostname}${port ? ':' + port : ''}`;
    }

    return 'http://127.0.0.1:3000';
  }

  function resolveApiUrl(path) {
    if (!path) return path;
    if (/^https?:\/\//i.test(path)) return path;
    const base = resolveApiBase();
    return `${base}${path.startsWith('/') ? path : '/' + path}`;
  }

  // Uploaded images (avatars, listing photos) are served by the API origin
  // (server/uploads), not necessarily the page's own origin — the two only
  // match when the frontend is served by the same Node process as the API.
  // Use this anywhere an uploaded image URL is rendered into the DOM.
  function resolveAssetUrl(src) {
    if (!src) return src;
    if (/^https?:\/\//i.test(src)) return src;
    if (src.startsWith('/uploads/')) return resolveApiUrl(src);
    return src;
  }

  function setSession(token, user) {
    localStorage.setItem('cm_token', token);
    localStorage.setItem('cm_user', JSON.stringify(user));
  }

  function clearSession() {
    localStorage.removeItem('cm_token');
    localStorage.removeItem('cm_user');
  }

  function cachedUser() {
    try {
      return JSON.parse(localStorage.getItem('cm_user') || 'null');
    } catch (e) {
      return null;
    }
  }

  async function request(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) {
      const token = getToken();
      if (token) headers['Authorization'] = 'Bearer ' + token;
    }

    const targetUrl = resolveApiUrl(path);

    let res;
    try {
      res = await fetch(targetUrl, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (networkErr) {
      throw new ApiError('Could not reach the Campus Market server. Is it running?', 0);
    }

    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }

    if (!res.ok) {
      if (res.status === 401) clearSession();
      throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status);
    }
    return data;
  }

  function qs(params) {
    const usp = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') usp.set(k, v);
    });
    const s = usp.toString();
    return s ? `?${s}` : '';
  }

  return {
    ApiError,
    getToken,
    setSession,
    clearSession,
    cachedUser,
    resolveApiBase,
    resolveApiUrl,
    resolveAssetUrl,

    /* ---- auth ---- */
    signup(payload) { return request('/api/auth/signup', { method: 'POST', body: payload, auth: false }); },
    login(payload) { return request('/api/auth/login', { method: 'POST', body: payload, auth: false }); },
    forgotPassword(identifier) { return request('/api/auth/forgot-password', { method: 'POST', body: { identifier }, auth: false }); },
    verifyResetCode(identifier, code) { return request('/api/auth/verify-reset-code', { method: 'POST', body: { identifier, code }, auth: false }); },
    resetPassword(resetToken, newPassword) { return request('/api/auth/reset-password', { method: 'POST', body: { resetToken, newPassword }, auth: false }); },
    me() { return request('/api/auth/me'); },
    uploadProfilePicture(payload) { return request('/api/auth/profile-picture', { method: 'POST', body: payload }); },

    /* ---- admin ---- */
    getAdminStats() { return request('/api/admin/stats'); },
    getAdminUsers() { return request('/api/admin/users'); },
    getAdminUserDetail(id) { return request(`/api/admin/users/${id}`); },
    approveUser(id, note) { return request(`/api/admin/users/${id}/approve`, { method: 'POST', body: { note } }); },
    rejectUser(id, note) { return request(`/api/admin/users/${id}/reject`, { method: 'POST', body: { note } }); },
    suspendUser(id, note) { return request(`/api/admin/users/${id}/suspend`, { method: 'POST', body: { note } }); },
    reinstateUser(id, note) { return request(`/api/admin/users/${id}/reinstate`, { method: 'POST', body: { note } }); },
    getAdminReports() { return request('/api/admin/reports'); },
    resolveReport(id, action, note) { return request(`/api/admin/reports/${id}/resolve`, { method: 'POST', body: { action, note } }); },
    getAdminProducts() { return request('/api/admin/products'); },
    adminRemoveProduct(id) { return request(`/api/admin/products/${id}/remove`, { method: 'POST' }); },
    adminRestoreProduct(id) { return request(`/api/admin/products/${id}/restore`, { method: 'POST' }); },
    getAdminSettings() { return request('/api/admin/settings'); },
    updateAdminSettings(minSalePercent) { return request('/api/admin/settings', { method: 'POST', body: { minSalePercent } }); },
    getDiscountCap() { return request('/api/settings/discount-cap'); },

    /* ---- products ---- */
    listProducts(params) { return request('/api/products' + qs(params)); },
    getProduct(id) { return request(`/api/products/${id}`); },
    createProduct(payload) { return request('/api/products', { method: 'POST', body: payload }); },
    updateProduct(id, payload) { return request(`/api/products/${id}`, { method: 'PUT', body: payload }); },
    deleteProduct(id) { return request(`/api/products/${id}`, { method: 'DELETE' }); },
    reportProduct(id, reason, details) { return request(`/api/products/${id}/report`, { method: 'POST', body: { reason, details } }); },

    /* ---- cart ---- */
    getCart() { return request('/api/cart'); },
    addToCart(payload) { return request('/api/cart', { method: 'POST', body: payload }); },
    updateCartItem(itemId, qty) { return request(`/api/cart/${itemId}`, { method: 'PATCH', body: { qty } }); },
    removeCartItem(itemId) { return request(`/api/cart/${itemId}`, { method: 'DELETE' }); },

    /* ---- meetup orders ---- */
    createOrder(payload) { return request('/api/orders', { method: 'POST', body: payload }); },
    listOrders() { return request('/api/orders'); },
    getOrder(id) { return request(`/api/orders/${id}`); },

    /* ---- messages ---- */
    listConversations() { return request('/api/conversations'); },
    startConversation(payload) { return request('/api/conversations', { method: 'POST', body: payload }); },
    getConversation(id) { return request(`/api/conversations/${id}`); },
    sendMessage(id, body) { return request(`/api/conversations/${id}/messages`, { method: 'POST', body: { body } }); },

    /* ---- notifications ---- */
    listNotifications() { return request('/api/notifications'); },
    markAllNotificationsRead() { return request('/api/notifications/read-all', { method: 'POST' }); },

    /* ---- favorites ---- */
    getFavoriteIds() { return request('/api/favorites'); },
    favorite(productId) { return request(`/api/favorites/${productId}`, { method: 'POST' }); },
    unfavorite(productId) { return request(`/api/favorites/${productId}`, { method: 'DELETE' }); },
  };
})();

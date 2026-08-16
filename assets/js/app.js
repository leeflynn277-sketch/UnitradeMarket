/* ============================================================
   Campus Market — shared app logic
   Talks to the real backend (server/server.js) via assets/js/api.js.
   Session (token + a cached copy of the user) lives in localStorage
   purely so pages can do a fast synchronous "am I logged in" check —
   every API call is still independently verified server-side.
   ============================================================ */

/* ---------- Session / auth ---------- */
function cmGetUser() {
    return Api.cachedUser();
}

function cmRequireLogin() {
    if (!cmGetUser()) {
        const returnTo = encodeURIComponent(location.pathname.split('/').pop() + location.search);
        window.location.href = 'login.html?returnTo=' + returnTo;
        return false;
    }
    return true;
}

function cmLogout() {
    Api.clearSession();
}

/* ---------- Bottom nav / topbar active state ---------- */
function cmMarkActiveNav() {
    const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    document.querySelectorAll('[data-nav-page]').forEach((el) => {
        if (el.getAttribute('data-nav-page').toLowerCase() === page) {
            el.classList.add('is-active');
        } else {
            el.classList.remove('is-active');
        }
    });
}

/* ---------- Back button helper ---------- */
function cmGoBack(fallback) {
    if (window.history.length > 1) {
        window.history.back();
    } else {
        window.location.href = fallback || 'index.html';
    }
}

/* ---------- Toast ---------- */
function cmToast(message) {
    let el = document.getElementById('cmToast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'cmToast';
        el.className = 'toast';
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('is-shown');
    clearTimeout(window.__cmToastTimer);
    window.__cmToastTimer = setTimeout(() => el.classList.remove('is-shown'), 2200);
}

/* ---------- Friendly error helper for API calls ---------- */
function cmHandleApiError(err, fallbackMessage) {
    console.error(err);
    cmToast((err && err.message) || fallbackMessage || 'Something went wrong.');
}

/* ---------- Cart badge (shown on cart icons across pages) ---------- */
async function cmRenderCartBadges() {
    const user = cmGetUser();
    let count = 0;
    if (user) {
        try {
            const { lines } = await Api.getCart();
            count = lines.reduce((sum, l) => sum + l.qty, 0);
        } catch (e) {
            count = 0;
        }
    }
    document.querySelectorAll('[data-cart-badge]').forEach((el) => {
        if (count > 0) {
            el.textContent = count > 9 ? '9+' : String(count);
            el.style.display = 'flex';
        } else {
            el.style.display = 'none';
        }
    });
}

/* ---------- Read URL query params ---------- */
function cmParam(name) {
    return new URLSearchParams(window.location.search).get(name);
}

/* ---------- Initials helper (used for avatars) ---------- */
function cmInitials(name) {
    return (name || '?').split(' ').map((n) => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

/* ---------- Redirect logged-out visitors away from profile links ---------- */
function cmRedirectProfileLinksToLogin() {
    const user = cmGetUser();
    if (user) return;
    document.querySelectorAll('a[href$="profile.html"]').forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            window.location.href = 'login.html';
        });
    });
}

function cmUpdateAuthNavigation() {
    const user = cmGetUser();
    const isLoggedIn = !!user;

    document.querySelectorAll('[data-auth-link="messages"]').forEach((link) => {
        link.hidden = !isLoggedIn;
    });
    document.querySelectorAll('[data-auth-link="alerts"]').forEach((link) => {
        link.hidden = !isLoggedIn;
    });

    document.querySelectorAll('[data-auth-link="profile"]').forEach((link) => {
        const label = link.querySelector('[data-auth-label]');
        if (isLoggedIn) {
            link.href = 'profile.html';
            if (label) label.textContent = 'Profile';
        } else {
            link.href = 'login.html';
            if (label) label.textContent = 'Login';
        }
    });

    document.querySelectorAll('[data-auth-footer]').forEach((link) => {
        if (isLoggedIn) {
            link.href = 'profile.html';
            link.textContent = 'Profile';
        } else {
            link.href = 'login.html';
            link.textContent = 'Sign In';
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    cmMarkActiveNav();
    cmRenderCartBadges();
    cmRedirectProfileLinksToLogin();
    cmUpdateAuthNavigation();
});

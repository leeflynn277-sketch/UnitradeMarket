# Campus Market deployment

## Recommended setup: deploy the whole app to Render

GitHub Pages can host the HTML/CSS/JS files, but it cannot run the Node.js backend. The easiest setup is to deploy this entire repository as one Render Web Service. The Node server serves both the frontend and `/api/*` endpoints from the same origin, so the frontend does not need a separate API URL.

### Render settings

- Service type: Web Service
- Repository: `campus-market`
- Build command: `npm install`
- Start command: `npm start`
- Plan: Free

Render supplies the `PORT` environment variable automatically. The server listens on `0.0.0.0`.

After deployment, use the Render URL, for example:

`https://campus-market-xxxx.onrender.com`

Do not open the GitHub Pages URL for the full application; GitHub Pages cannot execute `server/server.js`.

## If you insist on keeping GitHub Pages

Deploy the backend separately (for example on Render), then configure `window.CAMPUS_MARKET_API_BASE` in the frontend to the backend's HTTPS URL. The backend must also allow the GitHub Pages origin with CORS.

## Important storage limitation

The current app uses SQLite and local uploads. A free Render filesystem is ephemeral, so database changes and uploaded files are not guaranteed to survive restarts/redeploys. For a real production marketplace, move SQLite to a persistent/managed database and product images to persistent object storage.

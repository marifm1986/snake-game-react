"# snake-game-react" 

## Firestore Leaderboard Setup

To persist score data in Firestore, create a Firebase project, enable Firestore, and set these env vars in `.env`:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`

Then run:

```bash
npm install
npm run dev
```

If credentials are missing, the app falls back to localStorage leaderboard (top 10).

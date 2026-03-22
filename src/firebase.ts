import { initializeApp } from "firebase/app";
import { getDatabase, Database } from "firebase/database";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const hasMinConfig =
  typeof firebaseConfig.apiKey === "string" &&
  firebaseConfig.apiKey.length > 0 &&
  typeof firebaseConfig.databaseURL === "string" &&
  firebaseConfig.databaseURL.length > 0;

let db: Database | null = null;
let dbEnabled = false;

if (hasMinConfig) {
  try {
    const app = initializeApp(firebaseConfig);
    db = getDatabase(app);
    dbEnabled = true;
    console.log("Realtime Database initialized");
  } catch (error) {
    console.warn("Realtime Database init failed:", error);
    db = null;
    dbEnabled = false;
  }
} else {
  console.warn(
    "Firebase config not found in VITE_FIREBASE_* env vars. Falling back to local leaderboard."
  );
}

export { db, dbEnabled };

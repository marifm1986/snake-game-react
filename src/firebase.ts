import { initializeApp } from "firebase/app";
import { getFirestore, Firestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const hasMinConfig =
  typeof firebaseConfig.apiKey === "string" &&
  firebaseConfig.apiKey.length > 0 &&
  typeof firebaseConfig.projectId === "string" &&
  firebaseConfig.projectId.length > 0;

let db: Firestore | null = null;
let dbEnabled = false;

if (hasMinConfig) {
  try {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    dbEnabled = true;
    console.log("Firestore initialized");
  } catch (error) {
    console.warn("Firestore init failed:", error);
    db = null;
    dbEnabled = false;
  }
} else {
  console.warn(
    "Firebase config not found in VITE_FIREBASE_* env vars. Falling back to local leaderboard."
  );
}

export { db, dbEnabled };

import { initializeApp } from "firebase/app";
import { initializeFirestore, persistentLocalCache, persistentSingleTabManager, Firestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyBubbojisWVtf_PeBzBc8qWfMCL3bA3R5c",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "snake-game360.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "snake-game360",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "snake-game360.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "513748832712",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:513748832712:web:f26aca8aa6814d93a9b0fd",
};

let db: Firestore | null = null;
let dbEnabled = false;

try {
  const app = initializeApp(firebaseConfig);
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentSingleTabManager({ forceOwnership: true }),
    }),
  });
  dbEnabled = true;
} catch (error) {
  console.warn("Firestore init failed:", error);
  db = null;
  dbEnabled = false;
}

export { db, dbEnabled };

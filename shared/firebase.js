import { initializeApp, getApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getAuth, browserLocalPersistence, setPersistence
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCe36w6HmFGScPaSjbFRkxrvuD9VCNrqDk",
  authDomain: "g23f-studenplan.firebaseapp.com",
  projectId: "g23f-studenplan",
  storageBucket: "g23f-studenplan.firebasestorage.app",
  messagingSenderId: "585686898310",
  appId: "1:585686898310:web:3712285a4380ae380b6307"
};

export const ADMIN_EMAIL = "eliasbachmann08@gmail.com";
export const firebaseApp = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
export const db = getFirestore(firebaseApp);
export const auth = getAuth(firebaseApp);
auth.languageCode = "de";
export const authReady = setPersistence(auth, browserLocalPersistence).catch(() => {});

export function isAdminUser(user) {
  return user?.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

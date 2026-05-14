import { initializeApp } from 'firebase/app';
import { getAuth, OAuthProvider, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: "AIzaSyAYj94j5m8wNjO15H38ayI27wyXSk2lEnQ",
  authDomain: "dkan-4b061.firebaseapp.com",
  databaseURL: "https://dkan-4b061-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "dkan-4b061",
  storageBucket: "dkan-4b061.firebasestorage.app",
  messagingSenderId: "798777583909",
  appId: "1:798777583909:web:d4274577a479cac9d652cc",
  measurementId: "G-L5L1FW2LNV"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const rtdb = getDatabase(app);

export const microsoftProvider = new OAuthProvider('microsoft.com');
microsoftProvider.setCustomParameters({
  prompt: 'select_account',
  tenant: 'af9ef20a-3158-43a0-a1ab-ad72a03eb4c5'
});

export const googleProvider = new GoogleAuthProvider();

// FreeZone BD — Firebase Configuration
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBKGHw3l6aHR4_CVxuRZLnDg9mJMzZ31Dk",
  authDomain: "freezone-96692.firebaseapp.com",
  databaseURL: "https://freezone-96692-default-rtdb.firebaseio.com",
  projectId: "freezone-96692",
  storageBucket: "freezone-96692.firebasestorage.app",
  messagingSenderId: "291711014267",
  appId: "1:291711014267:web:0ba5a757437bafb60d19de",
  measurementId: "G-8R17HS56HV"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

/**
 * firebase.js (ES Module)
 * Firebase initialization + helper functions for Storage & Firestore.
 * Exposes helpers on `window` so plain <script> files can use them.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-analytics.js";
import {
    getStorage,
    ref as storageRef,
    uploadBytes,
    getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-storage.js";
import {
    getFirestore,
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    collection,
    addDoc,
    doc,
    getDoc,
    getDocFromCache,
    setDoc,
    serverTimestamp,
    increment
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import {
    getAuth,
    signInAnonymously,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";

// --- Firebase Configuration ---
const firebaseConfig = {
    apiKey: "AIzaSyDwSKAyQRZvLS1vv3xW4WcjArutzAmO5Ms",
    authDomain: "inventory-4522d.firebaseapp.com",
    projectId: "inventory-4522d",
    storageBucket: "inventory-4522d.firebasestorage.app",
    messagingSenderId: "932096360302",
    appId: "1:932096360302:web:4c63305f276eecd7674b7f",
    measurementId: "G-YYC91TPGLR"
};

// --- Initialize Services ---
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const storage = getStorage(app);

// Use standard getFirestore for reliable connection
// Note: If you need offline persistence, we can re-enable initializeFirestore later
const db = getFirestore(app);

/* 
let db;
try {
    db = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
} catch (error) {
    console.error("Firestore initialization error. Ensure the database is created in Firebase Console.", error);
}
*/
const auth = getAuth(app);

// --- Anonymous Auth (satisfies `request.auth != null` storage rules) ---
// This promise resolves once the user is signed in.
const authReady = signInAnonymously(auth)
    .then(() => console.log('[Firebase] Signed in anonymously.'))
    .catch(err => console.warn('[Firebase] Anonymous auth failed:', err));

// --- Helpers ---

/**
 * Format a Date as YYYY-MM-DD.
 */
function formatDate(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/**
 * Format a Date as HH-MM-SS.
 */
function formatTime(d) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}-${mm}-${ss}`;
}

/**
 * Upload a raw CSV File to Firebase Storage.
 * Path: uploads/{type}/{YYYY-MM-DD}/{HH-MM-SS}_{filename}
 * Returns the download URL on success.
 *
 * @param {File} file - The File object from an <input type="file">
 * @param {string} type - Category folder, e.g. "inventory-order" or "usage-rates"
 * @returns {Promise<string>} Download URL
 */
async function uploadCSVToFirebase(file, type) {
    // Ensure auth is ready before uploading
    await authReady;

    const now = new Date();
    const datePath = formatDate(now);
    const timePart = formatTime(now);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `uploads/${type}/${datePath}/${timePart}_${safeName}`;

    const fileRef = storageRef(storage, path);
    const snapshot = await uploadBytes(fileRef, file);
    const url = await getDownloadURL(snapshot.ref);
    return url;
}

/**
 * Save a data object to a Firestore collection.
 * Automatically adds a `createdAt` server timestamp.
 *
 * @param {string} collectionName - Firestore collection, e.g. "inventory-results"
 * @param {Object} data - The document payload
 * @returns {Promise<string>} The new document ID
 */
async function saveToFirestore(collectionName, data) {
    // Ensure auth is ready before writing
    await authReady;

    const docRef = await addDoc(collection(db, collectionName), {
        ...data,
        createdAt: serverTimestamp()
    });
    return docRef.id;
}

// --- App-Settings Persistence (single document) ---

const SETTINGS_DOC_REF = doc(db, 'app-settings', 'current');

/**
 * Load the persisted settings from Firestore.
 * Returns { maxInventory, consumptionDict, usagePerThousand, salesProjections }
 * or null if the document doesn't exist yet (first run).
 */
async function loadSettingsFromFirestore() {
    await authReady;

    // 1. No cache used — always fetch from server
    try {
        console.log('[Firebase] Fetching settings from server...');
        const snap = await getDoc(SETTINGS_DOC_REF);
        if (snap.exists()) {
            console.log('[Firebase] Settings loaded from Firestore.');
            return snap.data();
        }
        console.log('[Firebase] No settings doc found — using defaults.');
        return null;
    } catch (err) {
        console.warn('[Firebase] Server fetch failed — using defaults.', err);
        return null;
    }
}

/**
 * Persist the four AppState properties to a single Firestore document.
 * Uses setDoc (merge) so partial updates don't wipe other fields.
 *
 * @param {Object} data - { maxInventory, consumptionDict, usagePerThousand, salesProjections }
 */
async function saveSettingsToFirestore(data) {
    await authReady;
    try {
        await setDoc(SETTINGS_DOC_REF, {
            ...data,
            updatedAt: serverTimestamp()
        }, { merge: true });
        console.log('[Firebase] Settings saved to Firestore.');
    } catch (err) {
        console.warn('[Firebase] Failed to save settings:', err);
    }
}

// --- Statistics Helpers ---

/**
 * Updates the running variance totals for items.
 * Each item in `items` should have `{ matchedKey, diff }`.
 * Targets `stats/variance-totals` doc.
 */
async function updateVarianceTotals(items) {
    if (!items || !items.length) return;
    
    await authReady;

    const updates = {};
    for (const item of items) {
        // Only proceed if we have a valid key and a numeric diff
        if (item.matchedKey && typeof item.diff === 'number') {
            updates[item.matchedKey] = increment(item.diff);
        }
    }

    if (Object.keys(updates).length === 0) return;

    try {
        const statsRef = doc(db, "stats", "variance-totals");
        // merge: true ensures we don't overwrite other fields and creates the doc if missing
        await setDoc(statsRef, updates, { merge: true });
        console.log("[Firebase] Updated variance totals.");
    } catch (err) {
        console.error("[Firebase] Failed to update variance totals:", err);
    }
}

// --- Expose on window for non-module scripts ---
window.uploadCSVToFirebase = uploadCSVToFirebase;
window.saveToFirestore = saveToFirestore;
window.loadSettingsFromFirestore = loadSettingsFromFirestore;
window.saveSettingsToFirestore = saveSettingsToFirestore;
window.updateVarianceTotals = updateVarianceTotals;

console.log('[Firebase] Initialized — Storage & Firestore ready.');

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, onSnapshot, setDoc, deleteDoc, collection } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { setLogLevel } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";


// ----------------------------------------------------------------------
// --- 🚨 STEP 1: REPLACE THIS PLACEHOLDER WITH YOUR OWN FIREBASE CONFIG ---
// ----------------------------------------------------------------------
// You must replace all "YOUR..." values with the configuration from your Firebase project's web app setup.
const FIREBASE_CONFIG = {
    apiKey: "YOUR_API_KEY_HERE",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT_ID.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID"
};

// This is the unique identifier for the app's public data in Firestore.
const FIREBASE_APP_ID = "CoCreateMusic"; 
// ----------------------------------------------------------------------

let db;
let auth;
let currentUserId = null;
let isAuthReady = false;
let allowedUsers = [];

// UI Elements (window scope is necessary for onclick handlers in index.html)
const loadingView = document.getElementById('loading-view');
const mainContent = document.getElementById('main-content');
const accessDeniedView = document.getElementById('access-denied-view');
const deniedUidDisplay = document.getElementById('denied-uid-display');
const viewSelector = document.getElementById('view-selector');
const allowedUsersList = document.getElementById('allowed-users-list');
const userCount = document.getElementById('user-count');
const adminStatus = document.getElementById('admin-status');

// --- Core Functions (Exported to be called from index.html) ---

/**
 * Converts the current page view based on the selected option.
 * @param {string} viewId - 'piano' or 'admin'
 */
window.changeView = function(viewId) {
    document.querySelectorAll('.view').forEach(view => view.classList.add('hidden'));
    document.getElementById(`${viewId}-view`).classList.remove('hidden');
};

/**
 * Copies the content of a given element ID to the clipboard.
 * @param {string} elementId - The ID of the element containing the text to copy.
 */
window.copyUID = function(elementId) {
    const uidElement = document.getElementById(elementId);
    const uid = uidElement.textContent;
    
    const tempInput = document.createElement('input');
    tempInput.value = uid;
    document.body.appendChild(tempInput);
    
    tempInput.select();
    document.execCommand('copy');
    
    document.body.removeChild(tempInput);

    const statusId = elementId === 'denied-uid-display' ? 'copy-status-denied' : 'copy-status';
    const status = document.getElementById(statusId);
    
    if (status) {
        status.classList.remove('hidden');
        setTimeout(() => status.classList.add('hidden'), 1500);
    }
};

/**
 * Function called by the creator to grant themselves access from the denied screen.
 */
window.grantSelfAccess = function() {
    if (currentUserId) {
        // Pass the current user's ID to the addUser function
        window.addUser(currentUserId);
    } else {
        // Using console.error instead of alert/confirm for standard practice
        console.error("Cannot grant access yet. User ID not loaded."); 
    }
}

// --- Firestore and Access Control ---

/**
 * Sets up the real-time listener for the list of allowed users.
 */
function setupAccessListener() {
    if (!db || !isAuthReady) return;

    // The collection path will be: /artifacts/CoCreateMusic/public/data/allowed_users
    const allowedUsersPath = collection(db, `artifacts/${FIREBASE_APP_ID}/public/data/allowed_users`);
    
    // Listen for real-time changes
    onSnapshot(allowedUsersPath, (snapshot) => {
        const newAllowedUsers = [];
        snapshot.forEach(doc => {
            newAllowedUsers.push(doc.id);
        });
        
        allowedUsers = newAllowedUsers;
        renderAllowedUsers();
        checkAccessAndRender();
    }, (error) => {
        console.error("Error listening to allowed users:", error);
    });
}

/**
 * Renders the list of allowed users in the admin panel.
 */
function renderAllowedUsers() {
    allowedUsersList.innerHTML = '';
    userCount.textContent = allowedUsers.length;
    
    allowedUsers.forEach(uid => {
        const li = document.createElement('li');
        li.className = 'flex items-center justify-between p-2 bg-white rounded-md border text-gray-700 font-mono text-sm break-words';
        li.innerHTML = `
            <span class="flex-grow">${uid}</span>
            <button onclick="window.removeUser('${uid}')" title="Remove User" 
                    class="ml-3 text-red-500 hover:text-red-700 p-1 rounded-full hover:bg-red-100 transition duration-150">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
            </button>
        `;
        allowedUsersList.appendChild(li);
    });
}

/**
 * Checks if the current user is allowed and switches the main view.
 */
function checkAccessAndRender() {
    if (!isAuthReady || !currentUserId) return;

    const isAllowed = allowedUsers.includes(currentUserId);

    // Hide all views initially
    loadingView.classList.add('hidden');
    mainContent.classList.add('hidden');
    accessDeniedView.classList.add('hidden');
    
    if (isAllowed) {
        // Access Granted: Show the main app content
        mainContent.classList.remove('hidden');
        window.changeView(viewSelector.value); // Re-render the selected view
    } else {
        // Access Denied: Show the denial screen with their UID
        deniedUidDisplay.textContent = currentUserId;
        accessDeniedView.classList.remove('hidden');
    }
}

/**
 * Adds a user by UID to the allowed list in Firestore.
 * @param {string|null} uidToGrant - Optional UID to grant access (used for self-granting).
 */
window.addUser = async function(uidToGrant = null) {
    const input = document.getElementById('new-uid-input');
    const uidToAdd = uidToGrant || input.value.trim();
    adminStatus.textContent = '';
    
    if (uidToAdd.length < 10) {
        adminStatus.textContent = 'Please enter a valid UID (must be a long string).';
        adminStatus.classList.remove('text-green-600');
        adminStatus.classList.add('text-red-600');
        return;
    }

    try {
        // Document path: /artifacts/CoCreateMusic/public/data/allowed_users/{uid}
        const docRef = doc(db, `artifacts/${FIREBASE_APP_ID}/public/data/allowed_users`, uidToAdd);
        await setDoc(docRef, { addedBy: currentUserId, timestamp: new Date().toISOString() });
        
        adminStatus.textContent = `User ${uidToAdd.substring(0, 8)}... added successfully!`;
        adminStatus.classList.remove('text-red-600');
        adminStatus.classList.add('text-green-600');
        if (!uidToGrant) input.value = ''; // Only clear the input if we used the input box
        
    } catch (error) {
        adminStatus.textContent = `Error adding user: ${error.message.substring(0, 50)}...`;
        adminStatus.classList.remove('text-green-600');
        adminStatus.classList.add('text-red-600');
        console.error("Error adding user:", error);
    }
}

/**
 * Removes a user by UID from the allowed list in Firestore.
 * @param {string} uidToRemove - The UID to delete.
 */
window.removeUser = async function(uidToRemove) {
    // Note: In a real app, use a custom modal instead of window.confirm
    if (!confirm(`Are you sure you want to remove user ${uidToRemove} from the allowed list?`)) return; 

    try {
        const docRef = doc(db, `artifacts/${FIREBASE_APP_ID}/public/data/allowed_users`, uidToRemove);
        await deleteDoc(docRef);
        console.log(`User ${uidToRemove} removed.`);
    } catch (error) {
        // Note: In a real app, use a custom modal instead of window.alert
        console.error(`Failed to remove user: ${error.message}`); 
    }
}

// --- Initialization ---

async function initializeAndAuthenticate() {
    if (FIREBASE_CONFIG.apiKey === "YOUR_API_KEY_HERE") {
        loadingView.innerHTML = `<p class="text-xl font-bold text-red-600">Error: Please update FIREBASE_CONFIG in app.js with your project details.</p>`;
        return;
    }

    try {
        const app = initializeApp(FIREBASE_CONFIG);
        db = getFirestore(app);
        auth = getAuth(app);
        setLogLevel('debug');

        // We use anonymous sign-in for GitHub Pages since custom tokens are not available.
        await signInAnonymously(auth);

        // Wait for the auth state to be confirmed and store the UID
        onAuthStateChanged(auth, (user) => {
            if (user) {
                currentUserId = user.uid;
                isAuthReady = true;
                
                setupAccessListener(); 
            } else {
                console.error("Authentication Failed.");
            }
        });

    } catch (error) {
        loadingView.innerHTML = `<p class="text-xl font-bold text-red-600">Initialization Error: Check Firebase Config and Auth Setup.</p>`;
        console.error("Initialization failed:", error);
    }
}

// Start the application setup when the script loads
initializeAndAuthenticate();
